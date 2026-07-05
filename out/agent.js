"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CoWorkAgent = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const claudeClient_1 = require("./claudeClient");
const pipeline_1 = require("./pipeline");
const diffUtils_1 = require("./diffUtils");
// ─── Import tracer ───────────────────────────────────────────────────────────
// Deterministically extracts relative import paths from file contents and
// resolves them against the indexed file set. Handles JS/TS (ESM + CJS) and
// Python relative imports. One level deep — no transitive tracing.
function traceImports(fileContents, knownPaths) {
    const alreadyRead = new Set(fileContents.map(f => f.relPath));
    const discovered = new Set();
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
            if (!rawImport || !rawImport.startsWith('.')) {
                continue;
            }
            // Resolve the import path relative to the importing file's directory
            const joined = dir ? `${dir}/${rawImport}` : rawImport;
            const parts = joined.split('/');
            const resolved = [];
            for (const part of parts) {
                if (part === '..') {
                    resolved.pop();
                }
                else if (part !== '.') {
                    resolved.push(part);
                }
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
function inferGraphMode(prompt) {
    const p = prompt.toLowerCase();
    if (/\b(refactor|rename|migrate|everywhere|throughout|all\s+files?|update\s+all|replace\s+all|across\s+the\s+(codebase|project|repo))\b/.test(p)) {
        return 'transitive';
    }
    if (/\b(trace|flow|follow|chain|pipeline|deep|end.to.end|e2e|step.by.step|call\s+stack|execution\s+path)\b/.test(p)) {
        return 'dfs';
    }
    return 'hybrid';
}
class CoWorkAgent {
    constructor(indexer, outputChannel, historyStore) {
        this._history = [];
        this._terminal = null;
        this._historyStore = null;
        this._indexer = indexer;
        this._outputChannel = outputChannel;
        (0, claudeClient_1.setLogger)(msg => this._outputChannel.appendLine(msg));
        if (historyStore) {
            this._historyStore = historyStore;
            this._history = historyStore.load();
            this._outputChannel.appendLine(`[Agent] Loaded ${this._history.length} messages from history`);
        }
    }
    _ensureTerminal() {
        if (!this._terminal) {
            this._terminal = vscode.window.createTerminal('AI CoWork');
        }
        this._terminal.show();
        return this._terminal;
    }
    get history() { return this._history; }
    clearHistory() {
        this._history = [];
        this._historyStore?.clear();
    }
    // ─── Diagnostic error collection ─────────────────────────────────────────────
    // Waits briefly for language servers to process newly written files, then
    // collects all Error-severity diagnostics from the given URIs.
    async collectDiagnosticErrors(uris) {
        // Give language servers (TypeScript, Pylance, etc.) time to process edits
        await new Promise((r) => setTimeout(r, 2500));
        const lines = [];
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
    // ─── RESEARCH PHASE ──────────────────────────────────────────────────────────
    // ─── VERIFICATION PHASE ──────────────────────────────────────────────────────
    async verifyEdits(edits) {
        const errors = [];
        const root = this._indexer.getRoot();
        if (!root) {
            return { valid: true, errors: [] };
        }
        // Check each edit for basic validity
        for (const edit of edits) {
            if (!edit.relPath) {
                continue;
            }
            const absPath = path.join(root, edit.relPath);
            // Check: file exists (if not new)
            if (!edit.isNew && !fs.existsSync(absPath)) {
                errors.push({ file: edit.relPath, error: 'File does not exist' });
            }
            // Check: new file content is not empty
            if (edit.isNew && !edit.newContent) {
                errors.push({ file: edit.relPath, error: 'New file is empty' });
            }
            // Check: if replacing, oldString should exist in file
            if (!edit.isNew && edit.oldString && fs.existsSync(absPath)) {
                try {
                    const content = fs.readFileSync(absPath, 'utf8');
                    if (!content.includes(edit.oldString)) {
                        errors.push({
                            file: edit.relPath,
                            error: `Cannot find text to replace. Search string not found in file.`,
                        });
                    }
                }
                catch { }
            }
        }
        const valid = errors.length === 0;
        if (!valid) {
            this._outputChannel.appendLine(`[Verification] Found ${errors.length} issues:`);
            errors.forEach(e => this._outputChannel.appendLine(`  ${e.file}: ${e.error}`));
        }
        return { valid, errors };
    }
    // ─── Apply a validated list of edits to disk ─────────────────────────────────
    async applyEdits(edits, root) {
        const originalContents = new Map();
        const workingContents = new Map();
        const applied = [];
        const uris = [];
        // Pass 1 — new files created immediately; snippet hunks accumulated in memory
        for (const edit of edits) {
            if (edit.command) {
                this._outputChannel.appendLine(`[Agent] Executing command: ${edit.command}`);
                const term = this._ensureTerminal();
                term.sendText(edit.command);
            }
            if (!edit.relPath) {
                continue;
            }
            const absPath = path.join(root, edit.relPath);
            if (edit.isNew) {
                if (!edit.newContent) {
                    continue;
                }
                try {
                    const dir = path.dirname(absPath);
                    if (!fs.existsSync(dir)) {
                        fs.mkdirSync(dir, { recursive: true });
                    }
                    const uri = vscode.Uri.file(absPath);
                    const wsEdit = new vscode.WorkspaceEdit();
                    wsEdit.createFile(uri, { overwrite: false, ignoreIfExists: false });
                    wsEdit.insert(uri, new vscode.Position(0, 0), edit.newContent);
                    await vscode.workspace.applyEdit(wsEdit);
                    this._indexer.patchFile(absPath);
                    applied.push({ relPath: edit.relPath, absPath, originalContent: null, newContent: edit.newContent, summary: edit.summary, isNew: true });
                    uris.push(uri);
                    this._outputChannel.appendLine(`[Agent] Created: ${edit.relPath}`);
                }
                catch (e) {
                    this._outputChannel.appendLine(`[Agent] Failed to create ${edit.relPath}: ${e}`);
                    vscode.window.showErrorMessage(`AI CoWork: Failed to create ${edit.relPath}: ${e}`);
                }
            }
            else {
                // Load original content once per file
                if (!workingContents.has(absPath)) {
                    try {
                        const orig = fs.readFileSync(absPath, 'utf8');
                        originalContents.set(absPath, orig);
                        workingContents.set(absPath, orig);
                    }
                    catch {
                        this._outputChannel.appendLine(`[Agent] Could not read ${edit.relPath} — skipping hunk`);
                        continue;
                    }
                }
                const oldStr = edit.oldString ?? '';
                const newStr = edit.newString ?? '';
                const current = workingContents.get(absPath);
                const updated = (0, claudeClient_1.fuzzyFindReplace)(current, oldStr, newStr);
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
            }
            catch (e) {
                this._outputChannel.appendLine(`[Agent] Failed to write ${relPath}: ${e}`);
                vscode.window.showErrorMessage(`AI CoWork: Failed to write ${relPath}: ${e}`);
            }
        }
        await Promise.all(uris.map(uri => vscode.workspace.save(uri)));
        return { applied, uris };
    }
    // ─── Main turn ────────────────────────────────────────────────────────────────
    async runTurn(userPrompt, onStage, context, researchEnabled) {
        const config = vscode.workspace.getConfiguration('aiCowork');
        const provider = config.get('provider') ?? 'mistral';
        const isMistral = provider === 'mistral';
        const isGemini = provider === 'gemini';
        const apiKey = isGemini
            ? (config.get('geminiApiKey') ?? '')
            : isMistral
                ? (config.get('mistralApiKey') ?? '')
                : (config.get('apiKey') ?? '');
        const model = isGemini
            ? (config.get('geminiModel') ?? 'gemini-3-flash-preview')
            : isMistral
                ? (config.get('mistralModel') ?? 'mistral-large-latest')
                : (config.get('model') ?? 'claude-sonnet-4-20250514');
        const useParallel = config.get('parallelCoders') ?? false;
        const diagnosticFeedback = config.get('diagnosticFeedback') ?? true;
        if (!apiKey) {
            const providerName = isGemini ? 'Gemini' : isMistral ? 'Mistral' : 'Anthropic';
            const cmd = isGemini ? '"AI CoWork: Set Gemini API Key"' : isMistral ? '"AI CoWork: Set Mistral API Key"' : '"AI CoWork: Set Anthropic API Key"';
            throw new Error(`No ${providerName} API key configured. Run ${cmd} from the command palette.`);
        }
        // ── Build context preamble from selected lines / pinned files ─────────
        let contextPreamble = '';
        const forcedFileContents = [];
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
            }
            catch { /* unreadable — skip */ }
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
            }
            catch { /* unreadable — skip */ }
        }
        if (context?.pinnedFiles) {
            for (const absPath of context.pinnedFiles) {
                if (forcedFileContents.some(f => f.absPath === absPath)) {
                    continue;
                }
                const relPath = wsRoot ? path.relative(wsRoot, absPath) : path.basename(absPath);
                try {
                    const content = fs.readFileSync(absPath, 'utf8');
                    forcedFileContents.push({ absPath, relPath, content });
                    const preview = content.length > 6000 ? content.slice(0, 6000) + '\n...[truncated]' : content;
                    contextPreamble += `[REFERENCE ONLY — \`${relPath}\` pinned by the user as context/data. You are NOT limited to editing this file — edit whatever files the task actually requires.]\n\`\`\`\n${preview}\n\`\`\`\n\n`;
                }
                catch { /* unreadable — skip */ }
            }
        }
        const enrichedPrompt = contextPreamble ? `${contextPreamble}${userPrompt}` : userPrompt;
        const fileTree = this._indexer.index ? this._indexer.buildSelectionGraph() : '';
        // ── PHASE 0: RESEARCH ──────────────────────────────────────────────────────
        if (researchEnabled) {
            onStage('🔎 Researching...');
            // Perform initial research
            const { thinkAboutQuery } = await Promise.resolve().then(() => __importStar(require('./claudeClient')));
            const research = await thinkAboutQuery(apiKey, model, this._history, userPrompt);
            contextPreamble += `[DEEP RESEARCH: ${research.approach}]\n\n`;
            this._outputChannel.appendLine(`[Research] Approach: ${research.approach}`);
            this._outputChannel.appendLine(`[Research] Search terms: ${research.searchTerms.join(', ')}`);
        }
        // ── PHASE 0: THINKING ──────────────────────────────────────────────────────
        onStage('🧠 Thinking about your request...');
        const { thinkAboutQuery } = await Promise.resolve().then(() => __importStar(require('./claudeClient')));
        const thinking = await thinkAboutQuery(apiKey, model, this._history, userPrompt);
        this._outputChannel.appendLine(`[Thinking] Approach: ${thinking.approach}`);
        this._outputChannel.appendLine(`[Thinking] Search terms: ${thinking.searchTerms.join(', ')}`);
        // Research phase removed - go directly to main pipeline
        const finalPrompt = enrichedPrompt;
        // ── Phases 1–4: intent → file selection → plan → code/validate/review ──
        // resolvedFileContents is populated inside the resolveFiles callback so that
        // absPath is available for filesRead and applyEdits after runPipeline returns.
        let resolvedFileContents = [];
        let selectedFunctions = [];
        const pipelineResult = await (0, pipeline_1.runPipeline)(finalPrompt, fileTree, this._history, {
            apiKey,
            model,
            useParallel,
            maxAttempts: 3,
            expandSelections: (selections, prompt) => {
                // Use call graph to refine selections: include only relevant functions
                const refined = this._indexer.refineSelectionsWithCallGraph(selections);
                // Track which functions are being selected for display
                selectedFunctions = [];
                for (const r of refined) {
                    if (r.functions) {
                        for (const f of r.functions) {
                            selectedFunctions.push({
                                file: r.relPath,
                                name: f.name,
                                lines: `${f.lineStart}-${f.lineEnd}`
                            });
                        }
                    }
                }
                const refinedSelections = [];
                for (const r of refined) {
                    if (!r.functions) {
                        // Whole file selection
                        refinedSelections.push({ relPath: r.relPath });
                    }
                    else {
                        // For each function, include its line range
                        for (const f of r.functions) {
                            refinedSelections.push({
                                relPath: r.relPath,
                                lineStart: f.lineStart,
                                lineEnd: f.lineEnd
                            });
                        }
                    }
                }
                if (refinedSelections.length > selections.length) {
                    const fnSummary = refined
                        .filter(r => r.functions)
                        .map(r => `  ${r.relPath}: ${r.functions.map(f => `${f.name}(${f.lineStart}-${f.lineEnd})`).join(', ')}`)
                        .join('\n');
                    this._outputChannel.appendLine(`[Agent] Call graph refinement: ${selections.length} → ${refinedSelections.length} selections\n${fnSummary}`);
                }
                return refinedSelections.length > 0 ? refinedSelections : selections;
            },
            discoverSecondPass: (fileContents, secondPassPrompt) => {
                const alreadyRead = new Set(fileContents.map(f => f.relPath.replace(/\\/g, '/')));
                const scores = new Map();
                // Specific function/class range for a file — only set when a symbol lookup
                // finds an exact location. Whole-file additions clear this.
                const ranges = new Map();
                const wholeFile = new Set();
                const add = (relPath, points, range) => {
                    const key = relPath.replace(/\\/g, '/');
                    if (alreadyRead.has(key)) {
                        return;
                    }
                    const entry = this._indexer.index?.files.find(f => f.relPath.replace(/\\/g, '/') === key);
                    const hubBoost = entry && entry.baseScore > 0 ? Math.log1p(entry.baseScore) : 0;
                    scores.set(key, (scores.get(key) ?? 0) + points + hubBoost);
                    if (range && !wholeFile.has(key) && !ranges.has(key)) {
                        ranges.set(key, range); // first specific match wins
                    }
                    else if (!range) {
                        wholeFile.add(key); // whole-file request overrides any range
                        ranges.delete(key);
                    }
                };
                const configMode = vscode.workspace.getConfiguration('aiCowork').get('graphMode') ?? 'auto';
                const graphMode = configMode !== 'auto' ? configMode : inferGraphMode(secondPassPrompt);
                if (graphMode === 'transitive') {
                    // Full transitive closure — every file reachable at any depth
                    for (const f of fileContents) {
                        for (const dep of this._indexer.getTransitiveDeps(f.relPath)) {
                            add(dep, 3);
                        }
                        for (const caller of this._indexer.getDependents(f.relPath)) {
                            add(caller, 1);
                        }
                    }
                }
                else if (graphMode === 'dfs') {
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
                }
                else if (graphMode === 'bfs') {
                    const bfsVisited = new Set(alreadyRead);
                    const queue = [];
                    for (const f of fileContents) {
                        queue.push({ relPath: f.relPath, depth: 0 });
                        for (const caller of this._indexer.getDependents(f.relPath)) {
                            add(caller, 1);
                        }
                    }
                    while (queue.length > 0) {
                        const { relPath, depth } = queue.shift();
                        if (bfsVisited.has(relPath) || depth >= 2) {
                            continue;
                        }
                        bfsVisited.add(relPath);
                        for (const dep of this._indexer.getDependencies(relPath)) {
                            add(dep, Math.max(1, 3 - depth));
                            queue.push({ relPath: dep, depth: depth + 1 });
                        }
                    }
                }
                else {
                    const bfsVisited = new Set(alreadyRead);
                    const bfsQueue = [];
                    for (const f of fileContents) {
                        bfsQueue.push({ relPath: f.relPath, depth: 0 });
                        for (const caller of this._indexer.getDependents(f.relPath)) {
                            add(caller, 1);
                        }
                    }
                    while (bfsQueue.length > 0) {
                        const { relPath, depth } = bfsQueue.shift();
                        if (bfsVisited.has(relPath) || depth >= 2) {
                            continue;
                        }
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
                const promptWords = new Set((secondPassPrompt.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []).filter(w => w.length >= 3));
                for (const word of promptWords) {
                    const ctx = this._indexer.getFunctionContext(word);
                    if (ctx) {
                        add(ctx.relPath, 5, { lineStart: ctx.lineStart, lineEnd: ctx.lineEnd });
                    }
                    else {
                        for (const rp of this._indexer.getFilesExportingSymbol(word)) {
                            add(rp, 5);
                        }
                    }
                    for (const rp of this._indexer.getImportersOfSymbol(word)) {
                        add(rp, 3);
                    }
                }
                // Keyword boost (whole files — keywords don't map to specific functions)
                const promptTerms = [...promptWords].map(w => w.toLowerCase());
                for (const rp of this._indexer.searchFiles(promptTerms)) {
                    add(rp, 2);
                }
                // Content scan: identifiers in the read chunks → find their definitions.
                // Capped at 300 unique identifiers to avoid scanning massive files symbol-by-symbol.
                const allContent = fileContents.map(f => f.content).join('\n');
                const rawIds = allContent.match(/\b[A-Za-z_$][A-Za-z0-9_$]{2,}\b/g) ?? [];
                const identifiers = [...new Set(rawIds)].slice(0, 300);
                for (const id of identifiers) {
                    const ctx = this._indexer.getFunctionContext(id);
                    if (ctx) {
                        add(ctx.relPath, 4, { lineStart: ctx.lineStart, lineEnd: ctx.lineEnd });
                    }
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
                const root = this._indexer.getRoot();
                const knownPaths = new Set((this._indexer.index?.files ?? []).map(f => f.relPath));
                const filtered = selections.filter(sel => {
                    if (this._indexer.isFluxignored(sel.relPath)) {
                        return false;
                    }
                    if (knownPaths.size > 0 && !knownPaths.has(sel.relPath)) {
                        this._outputChannel.appendLine(`[Agent] Rejected unknown path: ${sel.relPath}`);
                        return false;
                    }
                    return true;
                });
                const out = [];
                for (const sel of filtered) {
                    const absPath = path.join(root, sel.relPath);
                    try {
                        const fullContent = fs.readFileSync(absPath, 'utf8');
                        // If the selector gave a specific line range, send only that chunk to the
                        // LLM (reduces context). Full content is stored for accurate reporting.
                        let chunk;
                        if (sel.lineStart && sel.lineEnd) {
                            const lines = fullContent.split('\n');
                            chunk = `// [lines ${sel.lineStart}–${sel.lineEnd}]\n` +
                                lines.slice(sel.lineStart - 1, sel.lineEnd).join('\n');
                            this._outputChannel.appendLine(`[Agent] Read chunk: ${sel.relPath} [${sel.lineStart}–${sel.lineEnd}]`);
                        }
                        else {
                            chunk = fullContent;
                        }
                        out.push({ relPath: sel.relPath, content: chunk });
                        resolvedFileContents.push({ relPath: sel.relPath, content: fullContent, absPath });
                    }
                    catch {
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
                    }
                    catch {
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
        const filesRead = resolvedFileContents.map(f => ({
            relPath: f.relPath, absPath: f.absPath, content: f.content,
        }));
        // ── Phase 5: Apply Edits ──────────────────────────────────────────────
        const root = this._indexer.getRoot() ?? wsRoot;
        const appliedEdits = [];
        const affectedUris = [];
        if (pipelineResult.edits.length > 0) {
            // ── PHASE 5: VERIFICATION ──────────────────────────────────────────────
            onStage('✅ Verifying edits...');
            const verification = await this.verifyEdits(pipelineResult.edits);
            if (!verification.valid) {
                this._outputChannel.appendLine(`[Verification] Found ${verification.errors.length} issue(s):`);
                verification.errors.forEach(e => {
                    this._outputChannel.appendLine(`  ${e.file}: ${e.error}`);
                });
                // Return early with error message instead of applying broken edits
                return {
                    reply: `❌ **Verification Failed**\n\nThe generated edits have issues:\n\n${verification.errors.map(e => `- **${e.file}**: ${e.error}`).join('\n')}\n\nPlease try again with more specific instructions.`,
                    thinking: pipelineResult.thinking,
                    edits: [],
                    filesRead,
                };
            }
            this._outputChannel.appendLine('[Verification] All edits are valid ✓');
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
                    const fixPlan = {
                        thinking: '',
                        summary: 'Fix diagnostic errors',
                        steps: appliedEdits.map((e) => ({ relPath: e.relPath, action: 'edit', description: `Fix errors: ${errors.split('\n').filter(l => l.startsWith(e.relPath)).join('; ')}` })),
                    };
                    const fixResult = await (0, claudeClient_1.generateEdits)(apiKey, model, this._history, `Fix these compiler/linter errors:\n\n${errors}`, currentFileMaps, fixPlan);
                    const { valid: validFixes, skipped: skippedFixes } = (0, claudeClient_1.validateEdits)(fixResult.edits, currentFileMaps);
                    skippedFixes.forEach(({ edit, reason }) => this._outputChannel.appendLine(`[Agent] Fix skipped "${edit.relPath}": ${reason}`));
                    if (validFixes.length > 0) {
                        const { applied: fixApplied } = await this.applyEdits(validFixes, root);
                        appliedEdits.push(...fixApplied);
                        this._outputChannel.appendLine(`[Agent] Applied ${fixApplied.length} diagnostic fix(es)`);
                    }
                }
                catch (e) {
                    this._outputChannel.appendLine(`[Agent] Diagnostic fix failed: ${e}`);
                }
            }
            else {
                this._outputChannel.appendLine(`[Agent] No diagnostic errors — code is clean ✅`);
            }
        }
        // ── Phase 7: Update conversation history ─────────────────────────────
        const now = Date.now();
        this._history.push({ role: 'user', content: userPrompt, timestamp: now });
        this._history.push({ role: 'assistant', content: pipelineResult.reply, timestamp: now });
        if (this._history.length > 40) {
            this._history = this._history.slice(-40);
        }
        this._historyStore?.save(this._history);
        return {
            filesRead,
            edits: appliedEdits,
            reply: pipelineResult.reply,
            thinking: pipelineResult.thinking,
            selectedFunctions: selectedFunctions.length > 0 ? selectedFunctions : undefined,
        };
    }
    /** Serialize a TurnResult for the webview (pre-compute diffs) */
    serialize(result) {
        return {
            reply: result.reply,
            thinking: result.thinking,
            filesRead: result.filesRead.map((f) => ({ relPath: f.relPath, absPath: f.absPath })),
            edits: (() => {
                // Deduplicate edits by file path — keep only the last edit for each file
                const editsMap = new Map();
                for (const e of result.edits) {
                    const key = e.absPath || e.relPath;
                    editsMap.set(key, e); // latest one wins
                }
                return Array.from(editsMap.values()).map((e) => {
                    const diff = (0, diffUtils_1.computeDiff)(e.originalContent ?? '', e.newContent);
                    return {
                        relPath: e.relPath, absPath: e.absPath,
                        summary: e.summary, isNew: e.isNew,
                        diffHtml: diff.diffHtml, addedLines: diff.addedLines, removedLines: diff.removedLines,
                    };
                });
            })(),
            ...(result.selectedFunctions && { selectedFunctions: result.selectedFunctions }),
        };
    }
}
exports.CoWorkAgent = CoWorkAgent;
//# sourceMappingURL=agent.js.map