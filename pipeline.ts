import {
  classifyIntent, classifyComplexity, selectFiles, createPlan, generateEdits,
  generateEditsParallel, reviewEdits, validateEdits, chatReply,
  CodePlan, RetryContext, RawClaudeEdit, TaskComplexity,
} from './claudeClient';
import { Message } from './types';

export interface PipelineOptions {
  apiKey: string;
  model: string;
  useParallel?: boolean;
  maxAttempts?: number;
  /** Called with selected file paths so the caller can supply file contents */
  resolveFiles?: (filesToRead: string[]) => Promise<{ relPath: string; content: string }[]>;
  /** Graph-based second-pass discovery — if provided, replaces the LLM second-pass call */
  discoverSecondPass?: (fileContents: { relPath: string; content: string }[], prompt: string) => string[];
  onStage?: (stage: string) => void;
}

export interface PipelineResult {
  reply: string;
  thinking: string;
  edits: RawClaudeEdit[];
  skipped: Array<{ edit: RawClaudeEdit; reason: string }>;
  filesRead: string[];
}

export async function runPipeline(
  prompt: string,
  fileTree: string,
  history: Message[],
  opts: PipelineOptions
): Promise<PipelineResult> {
  const {
    apiKey, model,
    useParallel = false,
    maxAttempts = 3,
    resolveFiles,
    onStage = () => {},
  } = opts;

  // 1. Intent
  onStage('🧠 Understanding intent...');
  const intent = await classifyIntent(apiKey, model, history, prompt);
  if (intent !== 'code') {
    onStage('💬 Thinking...');
    const reply = await chatReply(apiKey, model, history, prompt);
    return { reply, thinking: '', edits: [], skipped: [], filesRead: [] };
  }

  // 1b. Complexity — determines which pipeline stages to run
  onStage('⚡ Assessing task complexity...');
  const complexity: TaskComplexity = await classifyComplexity(apiKey, model, history, prompt);

  // 2. File selection
  onStage('🔍 Scanning workspace for relevant files...');
  const { filesToRead, thinking: selThinking } = await selectFiles(
    apiKey, model, fileTree, history, prompt
  );

  // 3. Read files via caller-supplied resolver (keeps pipeline.ts FS-agnostic)
  let fileContents: { relPath: string; content: string }[] = [];
  if (resolveFiles && filesToRead.length > 0) {
    onStage(`📂 Reading ${filesToRead.length} file(s)...`);
    fileContents = await resolveFiles(filesToRead);
  }

  // 3b. Second-pass — complex tasks only. Uses the graph-based callback when
  // available (zero API calls, deterministic). Falls back to LLM discovery
  // if the caller hasn't wired up the graph (e.g. index loaded from cache only).
  if (resolveFiles && fileContents.length > 0 && complexity === 'complex') {
    onStage('🔎 Checking for additional files...');
    let newFiles: string[];

    if (opts.discoverSecondPass) {
      newFiles = opts.discoverSecondPass(fileContents, prompt)
        .filter(f => !fileContents.some(fc => fc.relPath === f));
    } else {
      const initialPaths = fileContents.map(f => f.relPath);
      const contentsBlock = fileContents
        .map(f => `<file path="${f.relPath}">\n${f.content}\n</file>`)
        .join('\n\n');
      const { filesToRead: additionalFiles } = await selectFiles(
        apiKey, model, fileTree, history,
        `You have already read these files:\n\n${contentsBlock}\n\nOriginal task: ${prompt}\n\nGiven the file contents above, are there additional files needed to complete the task? Identify any imports, referenced modules, or related files not yet read. Do NOT re-list already-read files (${initialPaths.join(', ')}). Return [] if nothing more is needed.`
      );
      newFiles = additionalFiles.filter(f => !fileContents.some(fc => fc.relPath === f));
    }

    if (newFiles.length > 0) {
      onStage(`📂 Reading ${newFiles.length} additional file(s)...`);
      const extra = await resolveFiles(newFiles);
      fileContents.push(...extra);
    }
  }

  // 4. Plan — skipped for trivial tasks (coder goes straight to editing)
  let plan: CodePlan = { thinking: '', summary: '', steps: [] };
  if (complexity !== 'trivial') {
    onStage('📋 Planning implementation...');
    try {
      plan = await createPlan(apiKey, model, history, prompt, fileContents);
    } catch {
      // Planner failure is non-fatal — coder proceeds without a plan
    }

    if (!plan.steps.length) {
      return { reply: plan.summary || 'No changes required.', thinking: plan.thinking, edits: [], skipped: [], filesRead: filesToRead };
    }
  }

  // 5. Code → validate → (review + retry) loop
  //    trivial — one pass, no planner, no reviewer
  //    complex — full loop, second-pass files, parallel coders if enabled
  let retryContext: RetryContext | undefined;
  let lastResult = { edits: [] as RawClaudeEdit[], reply: '', thinking: '' };
  let lastSkipped: Array<{ edit: RawClaudeEdit; reason: string }> = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const runParallel = complexity === 'complex' && useParallel && !retryContext;

    if (complexity === 'trivial') {
      onStage('⚡ Coding...');
    } else if (runParallel) {
      onStage(`🤖 Coding (parallel, attempt ${attempt}/${maxAttempts})...`);
    } else {
      onStage(attempt === 1 ? '🤖 Coding...' : `🔄 Revising (attempt ${attempt}/${maxAttempts})...`);
    }

    const raw = runParallel
      ? await generateEditsParallel(apiKey, model, history, prompt, fileContents, plan)
      : await generateEdits(apiKey, model, history, prompt, fileContents, plan, retryContext);

    const { valid, skipped } = validateEdits(raw.edits, fileContents);
    lastSkipped = skipped;

    // Trivial tasks: skip reviewer and return on first pass
    if (complexity === 'trivial') {
      lastResult = { edits: valid, reply: raw.reply, thinking: raw.thinking };
      break;
    }

    onStage('🔍 Reviewing code...');
    const review = await reviewEdits(apiKey, model, plan, fileContents, valid);

    if (review.approved || attempt === maxAttempts) {
      lastResult = { edits: valid, reply: raw.reply, thinking: raw.thinking };
      break;
    }

    // Include skipped edit reasons so the coder knows what was thrown out and why
    const skippedIssues = skipped.map(
      ({ edit, reason }) => `Edit for "${edit.relPath}" was skipped before review: ${reason}`
    );
    retryContext = {
      previousEdits: raw.edits,
      reviewFeedback: review.feedback,
      issues: [...review.issues, ...skippedIssues],
    };
  }

  return {
    reply: lastResult.reply,
    thinking: lastResult.thinking || selThinking,
    edits: lastResult.edits,
    skipped: lastSkipped,
    filesRead: filesToRead,
  };
}
