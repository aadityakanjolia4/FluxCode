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
const diffUtils_1 = require("./diffUtils");
class CoWorkAgent {
    constructor(indexer, outputChannel, historyStore) {
        this._history = [];
        this._historyStore = null;
        this._indexer = indexer;
        this._outputChannel = outputChannel;
        if (historyStore) {
            this._historyStore = historyStore;
            this._history = historyStore.load();
            this._outputChannel.appendLine(`[Agent] Loaded ${this._history.length} messages from history`);
        }
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
    // ─── Apply a validated list of edits to disk ─────────────────────────────────
    async applyEdits(edits, root, fileMaps) {
        const originalContents = new Map();
        const workingContents = new Map();
        const applied = [];
        const uris = [];
        // Pass 1 — new files created immediately; snippet hunks accumulated in memory
        for (const edit of edits) {
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
            }
            catch (e) {
                this._outputChannel.appendLine(`[Agent] Failed to write ${relPath}: ${e}`);
                vscode.window.showErrorMessage(`AI CoWork: Failed to write ${relPath}: ${e}`);
            }
        }
        return { applied, uris };
    }
    // ─── Main turn ────────────────────────────────────────────────────────────────
    async runTurn(userPrompt, onStage) {
        const config = vscode.workspace.getConfiguration('aiCowork');
        const apiKey = config.get('apiKey') ?? '';
        const model = config.get('model') ?? 'claude-sonnet-4-20250514';
        const useParallel = config.get('parallelCoders') ?? false;
        const diagnosticFeedback = config.get('diagnosticFeedback') ?? true;
        if (!apiKey) {
            throw new Error('No API key configured. Run "AI CoWork: Set API Key" from the command palette.');
        }
        if (!this._indexer.index) {
            throw new Error('Workspace not indexed yet. Click "Index Workspace" first.');
        }
        // ── Phase 1: File Selection ───────────────────────────────────────────
        onStage('🔍 Scanning workspace for relevant files...');
        const fileTree = this._indexer.buildTreeString();
        const { filesToRead, thinking: selectionThinking } = await (0, claudeClient_1.selectFiles)(apiKey, model, fileTree, this._history, userPrompt);
        this._outputChannel.appendLine(`[Agent] Files selected: ${filesToRead.join(', ') || '(none)'}`);
        // ── Phase 2: Read Files ───────────────────────────────────────────────
        const fileContents = [];
        if (filesToRead.length > 0) {
            onStage(`📂 Reading ${filesToRead.length} file(s)...`);
            const root = this._indexer.getRoot();
            for (const relPath of filesToRead) {
                const absPath = path.join(root, relPath);
                try {
                    fileContents.push({ relPath, content: fs.readFileSync(absPath, 'utf8'), absPath });
                }
                catch {
                    this._outputChannel.appendLine(`[Agent] Could not read: ${relPath}`);
                }
            }
        }
        const fileMaps = fileContents.map((f) => ({ relPath: f.relPath, content: f.content }));
        // ── Phase 3: Plan ─────────────────────────────────────────────────────
        onStage('📋 Planning implementation...');
        let plan = { thinking: '', summary: '', steps: [] };
        try {
            plan = await (0, claudeClient_1.createPlan)(apiKey, model, this._history, userPrompt, fileMaps);
            this._outputChannel.appendLine(`[Agent] Plan: "${plan.summary}" (${plan.steps.length} steps)`);
        }
        catch (e) {
            this._outputChannel.appendLine(`[Agent] Planner failed, proceeding without plan: ${e}`);
        }
        // ── Phase 4: Code → Validate → Review loop ────────────────────────────
        const MAX_ATTEMPTS = 3;
        const rawResult = await (async () => {
            let retryContext;
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                // 4a. Generate edits (parallel or single)
                if (useParallel && !retryContext) {
                    onStage(`🤖 Coding (parallel, attempt ${attempt}/${MAX_ATTEMPTS})...`);
                }
                else {
                    onStage(attempt === 1 ? '🤖 Coding...' : `🔄 Revising (attempt ${attempt}/${MAX_ATTEMPTS})...`);
                }
                let editsResult;
                try {
                    editsResult = useParallel && !retryContext
                        ? await (0, claudeClient_1.generateEditsParallel)(apiKey, model, this._history, userPrompt, fileMaps, plan)
                        : await (0, claudeClient_1.generateEdits)(apiKey, model, this._history, userPrompt, fileMaps, plan, retryContext);
                }
                catch (e) {
                    if (attempt === MAX_ATTEMPTS) {
                        throw e;
                    }
                    this._outputChannel.appendLine(`[Agent] Coder failed (attempt ${attempt}): ${e} — retrying`);
                    retryContext = undefined;
                    continue;
                }
                // 4b. Validate edits before review (skip unsafe / unmatched hunks)
                const { valid, skipped } = (0, claudeClient_1.validateEdits)(editsResult.edits, fileMaps);
                if (skipped.length > 0) {
                    skipped.forEach(({ edit, reason }) => this._outputChannel.appendLine(`[Agent] Skipped edit "${edit.relPath}": ${reason}`));
                }
                editsResult.edits = valid;
                // 4c. Review
                onStage('🔍 Reviewing code...');
                const review = await (0, claudeClient_1.reviewEdits)(apiKey, model, plan, fileMaps, editsResult.edits);
                this._outputChannel.appendLine(`[Agent] Review ${attempt}: ${review.approved ? '✅ approved' : '❌ rejected'} — ${review.feedback}`);
                if (review.approved || attempt === MAX_ATTEMPTS) {
                    if (!review.approved) {
                        this._outputChannel.appendLine(`[Agent] Applying best-effort after ${MAX_ATTEMPTS} attempts.`);
                    }
                    return editsResult;
                }
                retryContext = { previousEdits: editsResult.edits, reviewFeedback: review.feedback, issues: review.issues };
                this._outputChannel.appendLine(`[Agent] Issues:\n${review.issues.map((i) => `  • ${i}`).join('\n')}`);
            }
            throw new Error('Unexpected exit from code-review loop');
        })();
        // ── Phase 5: Apply Edits ──────────────────────────────────────────────
        onStage(`✏️ Applying ${rawResult.edits.length} edit(s)...`);
        const root = this._indexer.getRoot();
        const filesRead = fileContents.map((f) => ({
            relPath: f.relPath, absPath: f.absPath, content: f.content,
        }));
        const { applied: appliedEdits, uris: affectedUris } = await this.applyEdits(rawResult.edits, root, fileMaps);
        // ── Phase 6: Diagnostic feedback loop ────────────────────────────────
        // After applying, ask VS Code language servers for errors and auto-fix them.
        if (diagnosticFeedback && affectedUris.length > 0) {
            onStage('🔬 Checking for diagnostic errors...');
            const errors = await this.collectDiagnosticErrors(affectedUris);
            if (errors) {
                this._outputChannel.appendLine(`[Agent] Diagnostic errors found:\n${errors}`);
                onStage('🩹 Auto-fixing diagnostic errors...');
                // Build current file state (post-edit) for the fix agent
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
                    let fixResult = await (0, claudeClient_1.generateEdits)(apiKey, model, this._history, `Fix these compiler/linter errors:\n\n${errors}`, currentFileMaps, fixPlan);
                    const { valid: validFixes, skipped: skippedFixes } = (0, claudeClient_1.validateEdits)(fixResult.edits, currentFileMaps);
                    skippedFixes.forEach(({ edit, reason }) => this._outputChannel.appendLine(`[Agent] Fix skipped "${edit.relPath}": ${reason}`));
                    if (validFixes.length > 0) {
                        const { applied: fixApplied } = await this.applyEdits(validFixes, root, currentFileMaps);
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
        this._history.push({ role: 'user', content: userPrompt });
        this._history.push({ role: 'assistant', content: rawResult.reply });
        if (this._history.length > 40) {
            this._history = this._history.slice(-40);
        }
        this._historyStore?.save(this._history);
        return {
            filesRead,
            edits: appliedEdits,
            reply: rawResult.reply,
            thinking: rawResult.thinking || selectionThinking,
        };
    }
    /** Serialize a TurnResult for the webview (pre-compute diffs) */
    serialize(result) {
        return {
            reply: result.reply,
            thinking: result.thinking,
            filesRead: result.filesRead.map((f) => ({ relPath: f.relPath, absPath: f.absPath })),
            edits: result.edits.map((e) => {
                const diff = (0, diffUtils_1.computeDiff)(e.originalContent ?? '', e.newContent);
                return {
                    relPath: e.relPath, absPath: e.absPath,
                    summary: e.summary, isNew: e.isNew,
                    diffHtml: diff.diffHtml, addedLines: diff.addedLines, removedLines: diff.removedLines,
                };
            }),
        };
    }
}
exports.CoWorkAgent = CoWorkAgent;
//# sourceMappingURL=agent.js.map