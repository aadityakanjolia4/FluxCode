import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceIndexer } from './indexer';
import {
  generateEdits, validateEdits, fuzzyFindReplace, setLogger,
  RawClaudeEdit, CodePlan,
} from './claudeClient';
import { runPipeline } from './pipeline';
import { computeDiff } from './diffUtils';
import { FileSelection, Message, TurnResult, FileRead, FileEdit, SerializedTurnResult, MessageContext } from './types';
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

// ─── Graph mode inference ────────────────────────────────────────────────────
// Automatically selects the traversal strategy that best matches the prompt.
//   transitive — broad, cross-cutting changes ("refactor", "rename everywhere")
//   dfs        — chain/flow tracing ("trace", "follow the pipeline")
//   hybrid     — default: BFS broad sweep + DFS deep dive into top findings
function inferGraphMode(prompt: string): 'hybrid' | 'dfs' | 'transitive' {
  const p = prompt.toLowerCase();
  if (/\b(refactor|rename|migrate|everywhere|throughout|all\s+files?|update\s+all|replace\s+all|across\s+the\s+(codebase|project|repo))\b/.test(p)) {
    return 'transitive';
  }
  if (/\b(trace|flow|follow|chain|pipeline|deep|end.to.end|e2e|step.by.step|call\s+stack|execution\s+path)\b/.test(p)) {
    return 'dfs';
  }
  return 'hybrid';
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
    setLogger(msg => this._outputChannel.appendLine(msg));
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

  private async executeCommand(command: string): Promise<void> {
    const terminal = vscode.window.createTerminal('AI CoWork Command');
    terminal.show();
    terminal.sendText(command);
  }

  private async applyEdits(
    edits: RawClaudeEdit[],
    root: string
  ): Promise<{ applied: FileEdit[]; uris: vscode.Uri[] }> {
    const originalContents = new Map<string, string>();
    const workingContents  = new Map<string, string>();
    const applied: FileEdit[] = [];
    const uris: vscode.Uri[] = [];

    // Pass 1 — new files created immediately; snippet hunks accumulated in memory; commands executed
    for (const edit of edits) {
      if (edit.command && typeof edit.command === 'string') {
        this._outputChannel.appendLine(`[Agent] Executing: ${edit.command}`);
        await this.executeCommand(edit.command);
        continue;
      }
      if (!edit.relPath) { continue; }
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

        const updated = fuzzyFindReplace(current, oldStr, newStr);
        if (updated === null) {
          this._outputChannel.appendLine(`[Agent] Snippet not found in ${edit.relPath}: "${oldStr.slice(0, 80)}"`);
          vscode.window.showWarningMessage(`AI CoWork: Could not locate snippet in ${edit.relPath}. File may have changed.`);
          continue;
        }

        workingContents.set(absPath, updated);
        this._outputChannel.appendLine(`[Agent] Hunk applied in memory: ${edit.relPath} — ${edit.summary}`);
      }
    }

    // Pass 2 — write each modified existing file as a single WorkspaceEdit (one undo step)
    for (const [absPath, newContent] of workingContents) {
      const relPath = path.relative(root, absPath);
      const originalContent = originalContents.get(absPath) ?? '';
      const summary = edits
        .filter((e) => !e.isNew && path.join(root, e.relPath ?? '') === absPath)
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

    await Promise.all(uris.map(uri => vscode.workspace.save(uri)));
    return { applied, uris };
  }

  // ─── Main turn ────────────────────────────────────────────────────────────────

  async runTurn(
    userPrompt: string,
    onStage: (stage: string) => void,
    context?: MessageContext
  ): Promise<TurnResult> {
    const config = vscode.workspace.getConfiguration('aiCowork');
    const provider = config.get<string>('provider') ?? 'mistral';
    const isMistral = provider === 'mistral';
    const isGemini  = provider === 'gemini';
    const apiKey = isGemini
      ? (config.get<string>('geminiApiKey') ?? '')
      : isMistral
        ? (config.get<string>('mistralApiKey') ?? '')
        : (config.get<string>('apiKey') ?? '');

    const model = isGemini
      ? (config.get<string>('geminiModel') ?? 'gemini-3-flash-preview')
      : isMistral
        ? (config.get<string>('mistralModel') ?? 'mistral-large-latest')
        : (config.get<string>('model') ?? 'claude-sonnet-4-20250514');
    const useParallel        = config.get<boolean>('parallelCoders') ?? false;
    const diagnosticFeedback = config.get<boolean>('diagnosticFeedback') ?? true;

    if (!apiKey) {
      const providerName = isGemini ? 'Gemini' : isMistral ? 'Mistral' : 'Anthropic';
      const cmd = isGemini ? '"AI CoWork: Set Gemini API Key"' : isMistral ? '"AI CoWork: Set Mistral API Key"' : '"AI CoWork: Set Anthropic API Key"';
      throw new Error(`No ${providerName} API key configured. Run ${cmd} from the command palette.`);
    }

    // ── Build context preamble from selected lines / pinned files ─────────
    let contextPreamble = '';
    const forcedFileContents: { relPath: string; content: string; absPath: string }[] = [];
    const wsRoot = this._indexer.getRoot() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

    // ── Always include currently open file as context ──────────────────────
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.uri.scheme === 'file') {
      const activeAbsPath = activeEditor.document.uri.fsPath;
      const activeRelPath = wsRoot ? path.relative(wsRoot, activeAbsPath) : path.basename(activeAbsPath);
      try {
        const activeContent = fs.readFileSync(activeAbsPath, 'utf8');
        if (!forcedFileContents.some(f => f.absPath === activeAbsPath)) {
          forcedFileContents.push({ absPath: activeAbsPath, relPath: activeRelPath, content: activeContent });
          const preview = activeContent.length > 6000 ? activeContent.slice(0, 6000) + '\n...[truncated]' : activeContent;
          contextPreamble += `[CURRENT FILE — \`${activeRelPath}\` is currently open in your editor. This is the primary context for your task.]\n\`\`\`\n${preview}\n\`\`\`\n\n`;
        }
      } catch { /* unreadable — skip */ }
    }

    if (context?.selectedLines) {
      const { absPath, relPath, startLine, endLine } = context.selectedLines;
      try {
        const fullContent = fs.readFileSync(absPath, 'utf8');
        const snippet = fullContent.split('\n').slice(startLine - 1, endLine).join('\n');
        contextPreamble += `[REFERENCE ONLY — lines ${startLine}–${endLine} of \`${relPath}\` that the user has selected. Use this as context/data for the task. You are NOT limited to editing this file or these lines — edit whatever files the task actually requires.]\n\`\`\`\n${snippet}\n\`\`\`\n\n`;
        if (!forcedFileContents.some(f => f.absPath === absPath)) {
          forcedFileContents.push({ absPath, relPath, content: fullContent });
        }
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
          contextPreamble += `[REFERENCE ONLY — \`${relPath}\` pinned by the user as context/data. You are NOT limited to editing this file — edit whatever files the task actually requires.]\n\`\`\`\n${preview}\n\`\`\`\n\n`;
        } catch { /* unreadable — skip */ }
      }
    }

    const enrichedPrompt = contextPreamble ? `${contextPreamble}${userPrompt}` : userPrompt;
    const fileTree = this._indexer.index ? this._indexer.buildSelectionGraph() : '';

    // ── Phases 1–4: intent → file selection → plan → code/validate/review ──
    // resolvedFileContents is populated inside the resolveFiles callback so that
    // absPath is available for filesRead and applyEdits after runPipeline returns.
    let resolvedFileContents: { relPath: string; content: string; absPath: string }[] = [];

    const pipelineResult = await runPipeline(enrichedPrompt, fileTree, this._history, {
      apiKey,
      model,
      useParallel,
      maxAttempts: 3,
      expandSelections: (selections, prompt) => {
        // Extract query tokens from the prompt — these drive relevance scoring
        const queryTokens = (prompt.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [])
          .filter(t => t.length >= 3);

        const knownPaths = new Set((this._indexer.index?.files ?? []).map(f => f.relPath.replace(/\\/g, '/')));
        const entryPaths = selections.map(s => s.relPath);

        // Guided best-first traversal: priority queue, always expands the
        // highest-relevance neighbor next. Scoring:
        //   +5 exports a query token (symbol match)
        //   +4 named import of a query token from this file (symbol-level precision)
        //   +2 keyword list overlaps query tokens
        //   +½ hub boost (log baseScore)
        //   ÷depth penalty
        const traversed = this._indexer.guidedTraversal(entryPaths, queryTokens, {
          direction: 'forward',
          maxDepth: 3,
          maxFiles: 8,
        });

        const extra: FileSelection[] = traversed
          .filter(r => knownPaths.has(r.relPath) && !this._indexer.isFluxignored(r.relPath))
          .map(r => ({ relPath: r.relPath }));

        if (extra.length > 0) {
          this._outputChannel.appendLine(
            `[Agent] Guided traversal: +${extra.length} file(s)\n` +
            traversed.map(r =>
              `  ${r.relPath} (depth:${r.depth} score:${r.score.toFixed(1)} via:${r.via} [${r.edgeType}])`
            ).join('\n')
          );
        }
        return [...selections, ...extra];
      },
      discoverSecondPass: (fileContents, secondPassPrompt): FileSelection[] => {
        const alreadyRead = new Set(fileContents.map(f => f.relPath.replace(/\\/g, '/')));
        const scores  = new Map<string, number>();
        // Specific function/class range for a file — only set when a symbol lookup
        // finds an exact location. Whole-file additions clear this.
        const ranges  = new Map<string, { lineStart: number; lineEnd: number }>();
        const wholeFile = new Set<string>();

        const add = (relPath: string, points: number, range?: { lineStart: number; lineEnd: number }) => {
          const key = relPath.replace(/\\/g, '/');
          if (alreadyRead.has(key)) { return; }
          const entry = this._indexer.index?.files.find(f => f.relPath.replace(/\\/g, '/') === key);
          const hubBoost = entry && entry.baseScore > 0 ? Math.log1p(entry.baseScore) : 0;
          scores.set(key, (scores.get(key) ?? 0) + points + hubBoost);
          if (range && !wholeFile.has(key) && !ranges.has(key)) {
            ranges.set(key, range);   // first specific match wins
          } else if (!range) {
            wholeFile.add(key);       // whole-file request overrides any range
            ranges.delete(key);
          }
        };

        const configMode = vscode.workspace.getConfiguration('aiCowork').get<string>('graphMode') ?? 'auto';
        const graphMode = configMode !== 'auto' ? configMode as 'bfs' | 'dfs' | 'transitive' | 'hybrid' : inferGraphMode(secondPassPrompt);

        if (graphMode === 'transitive') {
          // Full transitive closure — every file reachable at any depth
          for (const f of fileContents) {
            for (const dep of this._indexer.getTransitiveDeps(f.relPath)) { add(dep, 3); }
            for (const caller of this._indexer.getDependents(f.relPath)) { add(caller, 1); }
          }
        } else if (graphMode === 'dfs') {
          // DFS — follows each import chain to its full depth before backtracking.
          // Good for finding deeply nested dependencies along a specific path.
          // Score decays with depth: depth 1 = 3pts, depth 2 = 2pts, depth 3+ = 1pt.
          for (const f of fileContents) {
            for (const { relPath: dep, depth } of this._indexer.dfsTraversal(f.relPath, 'deps')) {
              add(dep, Math.max(1, 4 - depth));
            }
            for (const { relPath: caller } of this._indexer.dfsTraversal(f.relPath, 'dependents', 2)) {
              add(caller, 1);
            }
          }
        } else if (graphMode === 'bfs') {
          // BFS depth-2 — explores all direct deps first, then their deps
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
              add(dep, Math.max(1, 3 - depth));
              queue.push({ relPath: dep, depth: depth + 1 });
            }
          }
        } else {
          // Hybrid (default) — two-phase: BFS broad sweep then DFS deep dive into top findings
          // Phase 1: BFS depth-2 from all entry files
          type QItem = { relPath: string; depth: number };
          const bfsVisited = new Set<string>(alreadyRead);
          const bfsQueue: QItem[] = [];
          for (const f of fileContents) {
            bfsQueue.push({ relPath: f.relPath, depth: 0 });
            for (const caller of this._indexer.getDependents(f.relPath)) { add(caller, 1); }
          }
          while (bfsQueue.length > 0) {
            const { relPath, depth } = bfsQueue.shift()!;
            if (bfsVisited.has(relPath) || depth >= 2) { continue; }
            bfsVisited.add(relPath);
            for (const dep of this._indexer.getDependencies(relPath)) {
              add(dep, Math.max(1, 3 - depth));
              bfsQueue.push({ relPath: dep, depth: depth + 1 });
            }
          }

          // Phase 2: pick top 3 BFS results by score, run DFS (depth 2) from each
          const TOP_N = 3;
          const topBfs = [...scores.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, TOP_N)
            .map(([relPath]) => relPath);
          for (const startPath of topBfs) {
            for (const { relPath: dep, depth } of this._indexer.dfsTraversal(startPath, 'deps', 2)) {
              add(dep, Math.max(1, 3 - depth));
            }
          }
        }

        // Symbol boost from prompt words — resolve to exact function/class location
        const promptWords = new Set(
          (secondPassPrompt.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []).filter(w => w.length >= 3)
        );
        for (const word of promptWords) {
          const ctx = this._indexer.getFunctionContext(word);
          if (ctx) {
            add(ctx.relPath, 5, { lineStart: ctx.lineStart, lineEnd: ctx.lineEnd });
          } else {
            for (const rp of this._indexer.getFilesExportingSymbol(word)) { add(rp, 5); }
          }
          for (const rp of this._indexer.getImportersOfSymbol(word)) { add(rp, 3); }
        }

        // Keyword boost (whole files — keywords don't map to specific functions)
        const promptTerms = [...promptWords].map(w => w.toLowerCase());
        for (const rp of this._indexer.searchFiles(promptTerms)) { add(rp, 2); }

        // Content scan: identifiers in the read chunks → find their definitions.
        // Capped at 300 unique identifiers to avoid scanning massive files symbol-by-symbol.
        const allContent = fileContents.map(f => f.content).join('\n');
        const rawIds = allContent.match(/\b[A-Za-z_$][A-Za-z0-9_$]{2,}\b/g) ?? [];
        const identifiers = [...new Set(rawIds)].slice(0, 300);
        for (const id of identifiers) {
          const ctx = this._indexer.getFunctionContext(id);
          if (ctx) { add(ctx.relPath, 4, { lineStart: ctx.lineStart, lineEnd: ctx.lineEnd }); }
        }

        // Score threshold + hard cap:
        //   MIN_SCORE filters out files that only got picked up by weak signals
        //   (e.g. BFS depth-2 hub boost alone). Signals that exceed it:
        //     +5 exports a prompt symbol            (very relevant)
        //     +4 named import / content scan match  (very relevant)
        //     +3 imports a prompt symbol             (relevant)
        //     +2 keyword match or BFS depth-1        (moderately relevant)
        //     +1 BFS depth-2 / dependent only        (too weak — filtered out)
        //   MAX_SECOND_PASS is a hard safety cap even if many files pass the threshold.
        const MIN_SCORE = 2.5;
        const MAX_SECOND_PASS = 20;
        return [...scores.entries()]
          .filter(([, score]) => score >= MIN_SCORE)
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_SECOND_PASS)
          .map(([relPath]) => {
            const range = ranges.get(relPath);
            return range ? { relPath, ...range } : { relPath };
          });
      },
      resolveFiles: async (selections) => {
        const root = this._indexer.getRoot()!;
        const knownPaths = new Set((this._indexer.index?.files ?? []).map(f => f.relPath));
        const filtered = selections.filter(sel => {
          if (this._indexer.isFluxignored(sel.relPath)) { return false; }
          if (knownPaths.size > 0 && !knownPaths.has(sel.relPath)) {
            this._outputChannel.appendLine(`[Agent] Rejected unknown path: ${sel.relPath}`);
            return false;
          }
          return true;
        });
        const out: { relPath: string; content: string }[] = [];
        for (const sel of filtered) {
          const absPath = path.join(root, sel.relPath);
          try {
            const fullContent = fs.readFileSync(absPath, 'utf8');
            // If the selector gave a specific line range, send only that chunk to the
            // LLM (reduces context). Full content is stored for accurate reporting.
            let chunk: string;
            if (sel.lineStart && sel.lineEnd) {
              const lines = fullContent.split('\n');
              chunk = `// [lines ${sel.lineStart}–${sel.lineEnd}]\n` +
                lines.slice(sel.lineStart - 1, sel.lineEnd).join('\n');
              this._outputChannel.appendLine(`[Agent] Read chunk: ${sel.relPath} [${sel.lineStart}–${sel.lineEnd}]`);
            } else {
              chunk = fullContent;
            }
            out.push({ relPath: sel.relPath, content: chunk });
            resolvedFileContents.push({ relPath: sel.relPath, content: fullContent, absPath });
          } catch {
            this._outputChannel.appendLine(`[Agent] Could not read: ${sel.relPath}`);
          }
        }
        // Trace imports deterministically — add files directly imported by the
        // initial set that are in the index but not yet read
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
      const { applied, uris } = await this.applyEdits(pipelineResult.edits, root);
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
            const { applied: fixApplied } = await this.applyEdits(validFixes, root);
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
    const now = Date.now();
    this._history.push({ role: 'user', content: userPrompt, timestamp: now });
    this._history.push({ role: 'assistant', content: pipelineResult.reply, timestamp: now });
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
      edits: (() => {
        // Deduplicate edits by file path — keep only the last edit for each file
        const editsMap = new Map<string, typeof result.edits[0]>();
        for (const e of result.edits) {
          const key = e.absPath || e.relPath;
          editsMap.set(key, e); // latest one wins
        }
        return Array.from(editsMap.values()).map((e) => {
          const diff = computeDiff(e.originalContent ?? '', e.newContent);
          return {
            relPath: e.relPath, absPath: e.absPath,
            summary: e.summary, isNew: e.isNew,
            diffHtml: diff.diffHtml, addedLines: diff.addedLines, removedLines: diff.removedLines,
          };
        });
      })(),
    };
  }
}
