import {
  classifyIntent, classifyComplexity, selectFiles, selectFilesForChat, createPlan, generateEdits,
  generateEditsParallel, reviewEdits, validateEdits, chatReply,
  CodePlan, RetryContext, RawClaudeEdit, TaskComplexity,
} from './claudeClient';

import { FileSelection, Message } from './types';


export interface PipelineOptions {
  apiKey: string;
  model: string;
  useParallel?: boolean;
  maxAttempts?: number;
  researchEnabled?: boolean;
  /** Called with granular selections (file or function/class chunk) to supply content */
  resolveFiles?: (selections: FileSelection[]) => Promise<{ relPath: string; content: string }[]>;
  /**
   * Called immediately after the LLM returns its selections.
   * Runs guided traversal (best-first, scored by query relevance) on the
   * selected paths and merges additional related files before any are read.
   * Receives the prompt so it can extract query tokens for scoring.
   */
  expandSelections?: (selections: FileSelection[], prompt: string) => FileSelection[];
  /** Graph-based second-pass discovery — returns FileSelection[] to resolve */
  discoverSecondPass?: (fileContents: { relPath: string; content: string }[], prompt: string) => FileSelection[];
  onStage?: (stage: string) => void;
}

export interface PipelineResult {
  reply: string;
  thinking: string;
  edits: RawClaudeEdit[];
  skipped: Array<{ edit: RawClaudeEdit; reason: string }>;
  filesRead: FileSelection[];
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

  // 0. Research
  if (opts.researchEnabled) {
    onStage('🔎 Researching...');
    // Research logic is already handled by agent before pipeline if necessary
  }
  onStage('🧠 Understanding intent...');
  const intent = await classifyIntent(apiKey, model, history, prompt);

  // Handle commands (install, commit, build, etc.) and questions via chat
  if (intent !== 'code') {
    if (intent === 'command') {
      onStage('🔨 Executing command...');
    } else {
      onStage('🔍 Scanning workspace for relevant files...');
    }
    const { selections: chatSelections } = await selectFilesForChat(apiKey, model, fileTree, history, prompt);
    const expandedChatSelections = opts.expandSelections ? opts.expandSelections(chatSelections, prompt) : chatSelections;
    let chatFileContents: { relPath: string; content: string }[] = [];
    if (resolveFiles && expandedChatSelections.length > 0) {
      onStage(`📂 Reading ${expandedChatSelections.length} file(s)...`);
      chatFileContents = await resolveFiles(expandedChatSelections);
    }
    onStage('💬 Thinking...');
    const reply = await chatReply(apiKey, model, history, prompt, chatFileContents);
    return { reply, thinking: '', edits: [], skipped: [], filesRead: expandedChatSelections };
  }

  // 1b. Complexity — determines which pipeline stages to run
  onStage('⚡ Assessing task complexity...');
  const complexity: TaskComplexity = await classifyComplexity(apiKey, model, history, prompt);

  // 2. File selection — LLM returns granular FileSelection[] (function/class or whole file)
  onStage('🔍 Scanning workspace for relevant files...');
  const { selections, thinking: selThinking } = await selectFiles(
    apiKey, model, fileTree, history, prompt
  );

  // 3. Expand selections via BFS + DFS on the selected paths before reading
  const expandedSelections = opts.expandSelections ? opts.expandSelections(selections, prompt) : selections;
  if (expandedSelections.length > selections.length) {
    onStage(`🕸️ Graph expanded: ${selections.length} → ${expandedSelections.length} file(s)...`);
  }

  // 4. Read files via caller-supplied resolver (keeps pipeline.ts FS-agnostic)
  let fileContents: { relPath: string; content: string }[] = [];
  if (resolveFiles && expandedSelections.length > 0) {
    onStage(`📂 Reading ${expandedSelections.length} selection(s)...`);
    fileContents = await resolveFiles(expandedSelections);
  }

  // 4b. Second-pass — complex tasks only. Graph-based callback when available
  // (zero API calls, deterministic). Falls back to a second LLM selectFiles call.
  if (resolveFiles && fileContents.length > 0 && complexity === 'complex') {
    onStage('🔎 Checking for additional files...');
    let newSelections: FileSelection[];

    if (opts.discoverSecondPass) {
      const discovered = opts.discoverSecondPass(fileContents, prompt);
      newSelections = discovered.filter(s => !fileContents.some(fc => fc.relPath === s.relPath));
    } else {
      const initialPaths = fileContents.map(f => f.relPath);
      const contentsBlock = fileContents
        .map(f => `<file path="${f.relPath}">\n${f.content}\n</file>`)
        .join('\n\n');
      const { selections: additionalFiles } = await selectFiles(
        apiKey, model, fileTree, history,
        `You have already read these files:\n\n${contentsBlock}\n\nOriginal task: ${prompt}\n\nAre there additional files needed? Identify imports, referenced modules, or related files not yet read. Do NOT re-list already-read files (${initialPaths.join(', ')}). Return [] if nothing more is needed.`
      );
      newSelections = additionalFiles.filter(s => !fileContents.some(fc => fc.relPath === s.relPath));
    }

    if (newSelections.length > 0) {
      onStage(`📂 Reading ${newSelections.length} additional selection(s)...`);
      const extra = await resolveFiles(newSelections);
      fileContents.push(...extra);
    }
  }

  // 5. Plan — skipped for trivial tasks (coder goes straight to editing)
  let plan: CodePlan = { thinking: '', summary: '', steps: [] };
  if (complexity !== 'trivial') {
    onStage('📋 Planning implementation...');
    let plannerFailed = false;
    try {
      plan = await createPlan(apiKey, model, history, prompt, fileContents);
    } catch (e) {
      plannerFailed = true;
      onStage(`⚠️ Planner failed (${e instanceof Error ? e.message : String(e)}) — proceeding without plan...`);
    }

    // Only bail if the planner explicitly returned no steps (decided nothing to do).
    // If the planner threw, proceed to the coder anyway without a plan.
    if (!plannerFailed && !plan.steps.length) {
      return { reply: plan.summary || 'No changes required.', thinking: plan.thinking, edits: [], skipped: [], filesRead: selections };
    }
  }

  // 6. Code → validate → (review + retry) loop
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

    const skippedIssues = skipped.map(
      ({ edit, reason }) => `Edit for "${edit.relPath}" was skipped before review: ${reason}`
    );
    retryContext = {
      previousEdits: raw.edits,
      reviewFeedback: review.feedback,
      issues: [
        ...review.issues.map(i => `[${i.type}] ${i.file}: ${i.message} → ${i.suggestion}`),
        ...skippedIssues,
      ],
    };
  }

  return {
    reply: lastResult.reply,
    thinking: lastResult.thinking || selThinking,
    edits: lastResult.edits,
    skipped: lastSkipped,
    filesRead: selections,
  };
}
