import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceIndexer } from './indexer';
import {
  generateEdits, validateEdits,
  RawClaudeEdit, CodePlan,
} from './claudeClient';
import { runPipeline } from './pipeline';
import { computeDiff } from './diffUtils';
import { Message, TurnResult, FileRead, FileEdit, SerializedTurnResult, MessageContext } from './types';
import { HistoryStore } from './historyStore';

// ─── Import tracer ───────────────────────────────────────────────────────────
// Deterministically extracts relative import paths from file contents and
// resolves them against the indexed file set. Handles JS/TS (ESM + CJS) and
// Python relative imports. One level deep — no transitive tracing.

function traceImports(
  fileContents: { relPath: string; content: string }[],
  knownPaths: Set<string>
): string[] {
  const alreadyRead = new Set(fileContents.map(f => f.relPath));
  const discovered = new Set<string>();

  // Matches: import/export ... from './x', require('./x'), from .module import
  const IMPORT_RE = /(?:(?:import|export)[^'"]*from|require\s*\()\s*['"](\.[^'"]+)['"]|from\s+(\.[a-zA-Z0-9_.]+)\s+import/g;
  const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.vue', '.svelte'];
  const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];

  for (const { relPath, content } of fileContents) {
    // Normalise to posix-style so path arithmetic works uniformly
    const posixRel = relPath.replace(/\\/g, '/');
    const dir = posixRel.includes('/') ? posixRel.replace(/\/[^/]+$/, '') : '';

    IMPORT_RE.lastIndex = 0;
    let match;
    while ((match = IMPORT_RE.exec(content)) !== null) {
      const rawImport = match[1] ?? match[2]; // group 1 = ESM/CJS, group 2 = Python
      if (!rawImport || !rawImport.startsWith('.')) { continue; }

      // Resolve the import path relative to the importing file's directory
      const joined = dir ? `${dir}/${rawImport}` : rawImport;
      const parts = joined.split('/');
      const resolved: string[] = [];
      for (const part of parts) {
        if (part === '..') { resolved.pop(); }
        else if (part !== '.') { resolved.push(part); }
      }
      const base = resolved.join('/');

      const candidates = [
        base,
        ...EXTENSIONS.map(e => base + e),
        ...INDEX_FILES.map(f => `${base}/${f}`),
      ];

      for (const candidate of candidates) {
        if (knownPaths.has(candidate) && !alreadyRead.has(candidate) && !discovered.has(candidate)) {
          discovered.add(candidate);
          break;
        }
      }
    }
  }

  return [...discovered];
}

export class CoWorkAgent {
  private _history: Message[] = [];
  private _indexer: WorkspaceIndexer;
  private _outputChannel: vscode.OutputChannel;
  private _historyStore: HistoryStore | null = null;

  constructor(
    indexer: WorkspaceIndexer,
    outputChannel: vscode.OutputChannel,
    historyStore?: HistoryStore
  ) {
    this._indexer = indexer;
    this._outputChannel = outputChannel;
    if (historyStore) {
      this._historyStore = historyStore;
      this._history = historyStore.load();
      this._outputChannel.appendLine(`[Agent] Loaded ${this._history.length} messages from history`);
    }
  }

  get history(): Message[] { return this._history; }

  clearHistory(): void {
    this._history = [];
    this._historyStore?.clear();
  }

  // ─── Diagnostic error collection ─────────────────────────────────────────────
  // Waits briefly for language servers to process newly written files, then
  // collects all Error-severity diagnostics from the given URIs.

  private async collectDiagnosticErrors(uris: vscode.Uri[]): Promise<string | null> {
    // Give language servers (TypeScript, Pylance, etc.) time to process edits
    await new Promise((r) => setTimeout(r, 2500));

    const lines: string[] = [];
    for (const uri of uris) {
      const diags = vscode.languages.getDiagnostics(uri);
      for (const d of diags) {
        if (d.severity === vscode.DiagnosticSeverity.Error) {
          const rel = vscode.workspace.asRelativePath(uri);
          lines.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1}: ${d.message}`);
        }
      }
    }
    return lines.length > 0 ? lines.join('\n') : null;
  }

  // ─── Apply a validated list of edits to disk ─────────────────────────────────

  private async applyEdits(
    edits: RawClaudeEdit[],
    root: string,
    fileMaps: { relPath: string; content: string }[]
  ): Promise<{ applied: FileEdit[]; uris: vscode.Uri[] }> {
    const originalContents = new Map<string, string>();
    const workingContents  = new Map<string, string>();
    const applied: FileEdit[] = [];
    const uris: vscode.Uri[] = [];

    // Pass 1 — new files created immediately; snippet hunks accumulated in memory
    for (const edit of edits) {
      const absPath = path.join(root, edit.relPath);

      if (edit.isNew) {
        if (!edit.newContent) { continue; }
        try {
          const dir = path.dirname(absPath);
          if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }

          const uri = vscode.Uri.file(absPath);
          const wsEdit = new vscode.WorkspaceEdit();
          wsEdit.createFile(uri, { overwrite: false, ignoreIfExists: false });
          wsEdit.insert(uri, new vscode.Position(0, 0), edit.newContent);
          await vscode.workspace.applyEdit(wsEdit);
          this._indexer.patchFile(absPath);

          applied.push({ relPath: edit.relPath, absPath, originalContent: null, newContent: edit.newContent, summary: edit.summary, isNew: true });
          uris.push(uri);
          this._outputChannel.appendLine(`[Agent] Created: ${edit.relPath}`);
        } catch (e) {
          this._outputChannel.appendLine(`[Agent] Failed to create ${edit.relPath}: ${e}`);
          vscode.window.showErrorMessage(`AI CoWork: Failed to create ${edit.relPath}: ${e}`);
        }

      } else {
        // Load original content once per file
        if (!workingContents.has(absPath)) {
          try {
            const orig = fs.readFileSync(absPath, 'utf8');
            originalContents.set(absPath, orig);
            workingContents.set(absPath, orig);
          } catch {
            this._outputChannel.appendLine(`[Agent] Could not read ${edit.relPath} — skipping hunk`);
            continue;
          }
        }

        const oldStr = edit.oldString ?? '';
        const newStr = edit.newString ?? '';
        const current = workingContents.get(absPath)!;

        if (!current.includes(oldStr)) {
          this._outputChannel.appendLine(`[Agent] Snippet not found in ${edit.relPath}: "${oldStr.slice(0, 80)}"`);
          vscode.window.showWarningMessage(`AI CoWork: Could not locate snippet in ${edit.relPath}. File may have changed.`);
          continue;
        }

        workingContents.set(absPath, current.replace(oldStr, newStr));
        this._outputChannel.appendLine(`[Agent] Hunk applied in memory: ${edit.relPath} — ${edit.summary}`);
      }
    }

    // Pass 2 — write each modified existing file as a single WorkspaceEdit (one undo step)
    for (const [absPath, newContent] of workingContents) {
      const relPath = path.relative(root, absPath);
      const originalContent = originalContents.get(absPath) ?? '';
      const summary = edits
        .filter((e) => !e.isNew && path.join(root, e.relPath) === absPath)
        .map((e) => e.summary).join('; ');

      try {
        const uri = vscode.Uri.file(absPath);
        const wsEdit = new vscode.WorkspaceEdit();
        const doc = await vscode.workspace.openTextDocument(uri);
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        wsEdit.replace(uri, fullRange, newContent);
        await vscode.workspace.applyEdit(wsEdit);
        this._indexer.patchFile(absPath);

        applied.push({ relPath, absPath, originalContent, newContent, summary, isNew: false });
        uris.push(uri);
        this._outputChannel.appendLine(`[Agent] Written: ${relPath}`);
      } catch (e) {
        this._outputChannel.appendLine(`[Agent] Failed to write ${relPath}: ${e}`);
        vscode.window.showErrorMessage(`AI CoWork: Failed to write ${relPath}: ${e}`);
      }
    }

    return { applied, uris };
  }

  // ─── Main turn ────────────────────────────────────────────────────────────────

  async runTurn(
    userPrompt: string,
    onStage: (stage: string) => void,
    context?: MessageContext
  ): Promise<TurnResult> {
    const config = vscode.workspace.getConfiguration('aiCowork');
    const apiKey   = config.get<string>('apiKey') ?? '';
    const model    = config.get<string>('model') ?? 'claude-sonnet-4-20250514';
    const useParallel        = config.get<boolean>('parallelCoders') ?? false;
    const diagnosticFeedback = config.get<boolean>('diagnosticFeedback') ?? true;

    if (!apiKey) {
      throw new Error('No API key configured. Run "AI CoWork: Set API Key" from the command palette.');
    }

    // ── Build context preamble from selected lines / pinned files ─────────
    let contextPreamble = '';
    const forcedFileContents: { relPath: string; content: string; absPath: string }[] = [];
    const wsRoot = this._indexer.getRoot() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    if (context?.selectedLines) {
      const { absPath, relPath, startLine, endLine } = context.selectedLines;
      try {
        const fullContent = fs.readFileSync(absPath, 'utf8');
        const snippet = fullContent.split('\n').slice(startLine - 1, endLine).join('\n');
        contextPreamble += `User is focused on lines ${startLine}–${endLine} of \`${relPath}\`:\n\`\`\`\n${snippet}\n\`\`\`\n\n`;
        forcedFileContents.push({ absPath, relPath, content: fullContent });
      } catch { /* unreadable — skip */ }
    }

    if (context?.pinnedFiles) {
      for (const absPath of context.pinnedFiles) {
        if (forcedFileContents.some(f => f.absPath === absPath)) { continue; }
        const relPath = wsRoot ? path.relative(wsRoot, absPath) : path.basename(absPath);
        try {
          const content = fs.readFileSync(absPath, 'utf8');
          forcedFileContents.push({ absPath, relPath, content });
          const preview = content.length > 6000 ? content.slice(0, 6000) + '\n...[truncated]' : content;
          contextPreamble += `Content of \`${relPath}\`:\n\`\`\`\n${preview}\n\`\`\`\n\n`;
        } catch { /* unreadable — skip */ }
      }
    }

    const enrichedPrompt = contextPreamble ? `${contextPreamble}${userPrompt}` : userPrompt;
    const fileTree = this._indexer.index ? this._indexer.buildAnnotatedTree() : '';

    // ── Phases 1–4: intent → file selection → plan → code/validate/review ──
    // resolvedFileContents is populated inside the resolveFiles callback so that
    // absPath is available for filesRead and applyEdits after runPipeline returns.
    let resolvedFileContents: { relPath: string; content: string; absPath: string }[] = [];

    const pipelineResult = await runPipeline(enrichedPrompt, fileTree, this._history, {
      apiKey,
      model,
      useParallel,
      maxAttempts: 3,
      discoverSecondPass: (fileContents, secondPassPrompt) => {
        const alreadyRead = new Set(fileContents.map(f => f.relPath));
        const scored = new Map<string, number>();
        const add = (relPath: string, points: number) => {
          if (alreadyRead.has(relPath)) { return; }
          scored.set(relPath, (scored.get(relPath) ?? 0) + points);
        };

        const useTransitive = vscode.workspace.getConfiguration('aiCowork').get<boolean>('transitiveGraph') ?? false;

        if (useTransitive) {
          // Full transitive closure — every file reachable at any depth
          for (const f of fileContents) {
            for (const dep of this._indexer.getTransitiveDeps(f.relPath)) { add(dep, 3); }
            for (const caller of this._indexer.getDependents(f.relPath)) { add(caller, 1); }
          }
        } else {
          // BFS depth 2 with point decay
          type QItem = { relPath: string; depth: number };
          const bfsVisited = new Set<string>(alreadyRead);
          const queue: QItem[] = [];

          for (const f of fileContents) {
            queue.push({ relPath: f.relPath, depth: 0 });
            for (const caller of this._indexer.getDependents(f.relPath)) { add(caller, 1); }
          }

          while (queue.length > 0) {
            const { relPath, depth } = queue.shift()!;
            if (bfsVisited.has(relPath) || depth >= 2) { continue; }
            bfsVisited.add(relPath);
            for (const dep of this._indexer.getDependencies(relPath)) {
              const pts = Math.max(1, 3 - depth);
              add(dep, pts);
              queue.push({ relPath: dep, depth: depth + 1 });
            }
          }
        }

        // Symbol boost — always applied regardless of mode
        const promptWords = new Set(
          (secondPassPrompt.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []).filter(w => w.length >= 3)
        );
        for (const word of promptWords) {
          for (const relPath of this._indexer.getFilesExportingSymbol(word)) { add(relPath, 5); }
        }

        return [...scored.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([relPath]) => relPath);
      },
      resolveFiles: async (filesToRead) => {
        const root = this._indexer.getRoot()!;
        const knownPaths = new Set((this._indexer.index?.files ?? []).map(f => f.relPath));
        const filtered = filesToRead.filter((p: string) => {
          if (this._indexer.isFluxignored(p)) { return false; }
          if (knownPaths.size > 0 && !knownPaths.has(p)) {
            this._outputChannel.appendLine(`[Agent] Rejected unknown path: ${p}`);
            return false;
          }
          return true;
        });
        const out: { relPath: string; content: string }[] = [];
        for (const relPath of filtered) {
          const absPath = path.join(root, relPath);
          try {
            const content = fs.readFileSync(absPath, 'utf8');
            out.push({ relPath, content });
            resolvedFileContents.push({ relPath, content, absPath });
          } catch {
            this._outputChannel.appendLine(`[Agent] Could not read: ${relPath}`);
          }
        }
        // Trace imports deterministically — add any files directly imported by
        // the initial set that are in the index but not yet read
        const importTraced = traceImports(out, knownPaths);
        for (const relPath of importTraced) {
          const absPath = path.join(root, relPath);
          try {
            const content = fs.readFileSync(absPath, 'utf8');
            out.push({ relPath, content });
            resolvedFileContents.push({ relPath, content, absPath });
            this._outputChannel.appendLine(`[Agent] Import-traced: ${relPath}`);
          } catch {
            this._outputChannel.appendLine(`[Agent] Could not read traced: ${relPath}`);
          }
        }

        // Inject forced context (pinned files / selected lines) — deduplicated
        for (const f of forcedFileContents) {
          if (!out.some(fc => fc.relPath === f.relPath)) {
            out.push({ relPath: f.relPath, content: f.content });
            resolvedFileContents.push(f);
            this._outputChannel.appendLine(`[Agent] Context file injected: ${f.relPath}`);
          }
        }
        return out;
      },
      onStage,
    });

    const filesRead: FileRead[] = resolvedFileContents.map(f => ({
      relPath: f.relPath, absPath: f.absPath, content: f.content,
    }));

    // ── Phase 5: Apply Edits ──────────────────────────────────────────────
    const root = this._indexer.getRoot() ?? wsRoot;
    const appliedEdits: FileEdit[] = [];
    const affectedUris: vscode.Uri[] = [];

    if (pipelineResult.edits.length > 0) {
      onStage(`✏️ Applying ${pipelineResult.edits.length} edit(s)...`);
      const fileMaps = resolvedFileContents.map(f => ({ relPath: f.relPath, content: f.content }));
      const { applied, uris } = await this.applyEdits(pipelineResult.edits, root, fileMaps);
      appliedEdits.push(...applied);
      affectedUris.push(...uris);
    }

    // ── Phase 6: Diagnostic feedback loop ────────────────────────────────
    if (diagnosticFeedback && affectedUris.length > 0) {
      onStage('🔬 Checking for diagnostic errors...');
      const errors = await this.collectDiagnosticErrors(affectedUris);

      if (errors) {
        this._outputChannel.appendLine(`[Agent] Diagnostic errors found:\n${errors}`);
        onStage('🩹 Auto-fixing diagnostic errors...');

        const currentFileMaps = appliedEdits.map((e) => ({
          relPath: e.relPath,
          content: e.newContent,
        }));

        try {
          const fixPlan: CodePlan = {
            thinking: '',
            summary: 'Fix diagnostic errors',
            steps: appliedEdits.map((e) => ({ relPath: e.relPath, action: 'edit' as const, description: `Fix errors: ${errors.split('\n').filter(l => l.startsWith(e.relPath)).join('; ')}` })),
          };

          const fixResult = await generateEdits(
            apiKey, model, this._history,
            `Fix these compiler/linter errors:\n\n${errors}`,
            currentFileMaps, fixPlan
          );

          const { valid: validFixes, skipped: skippedFixes } = validateEdits(fixResult.edits, currentFileMaps);
          skippedFixes.forEach(({ edit, reason }) =>
            this._outputChannel.appendLine(`[Agent] Fix skipped "${edit.relPath}": ${reason}`)
          );

          if (validFixes.length > 0) {
            const { applied: fixApplied } = await this.applyEdits(validFixes, root, currentFileMaps);
            appliedEdits.push(...fixApplied);
            this._outputChannel.appendLine(`[Agent] Applied ${fixApplied.length} diagnostic fix(es)`);
          }
        } catch (e) {
          this._outputChannel.appendLine(`[Agent] Diagnostic fix failed: ${e}`);
        }
      } else {
        this._outputChannel.appendLine(`[Agent] No diagnostic errors — code is clean ✅`);
      }
    }

    // ── Phase 7: Update conversation history ─────────────────────────────
    this._history.push({ role: 'user', content: userPrompt });
    this._history.push({ role: 'assistant', content: pipelineResult.reply });
    if (this._history.length > 40) { this._history = this._history.slice(-40); }
    this._historyStore?.save(this._history);

    return {
      filesRead,
      edits: appliedEdits,
      reply: pipelineResult.reply,
      thinking: pipelineResult.thinking,
    };
  }

  /** Serialize a TurnResult for the webview (pre-compute diffs) */
  serialize(result: TurnResult): SerializedTurnResult {
    return {
      reply: result.reply,
      thinking: result.thinking,
      filesRead: result.filesRead.map((f) => ({ relPath: f.relPath, absPath: f.absPath })),
      edits: result.edits.map((e) => {
        const diff = computeDiff(e.originalContent ?? '', e.newContent);
        return {
          relPath: e.relPath, absPath: e.absPath,
          summary: e.summary, isNew: e.isNew,
          diffHtml: diff.diffHtml, addedLines: diff.addedLines, removedLines: diff.removedLines,
        };
      }),
    };
  }
}
