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
exports.WorkspaceIndexer = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const symbolExtractor_1 = require("./symbolExtractor");
const embedder_1 = require("./embedder");
// File extensions we care about
const SUPPORTED_EXTS = new Set([
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
    'py', 'go', 'rs', 'java', 'kt', 'swift',
    'c', 'cpp', 'h', 'hpp', 'cs',
    'json', 'yaml', 'yml', 'toml', 'env',
    'md', 'mdx', 'txt',
    'html', 'css', 'scss', 'sass', 'less',
    'vue', 'svelte', 'astro',
    'sql', 'graphql', 'proto',
    'sh', 'bash', 'zsh', 'fish',
    'dockerfile', 'makefile',
    'xml', 'prisma',
]);
// Always skip these regardless of gitignore
const ALWAYS_SKIP_DIRS = new Set([
    'node_modules', '.git', '.svn', '.hg',
    'dist', 'build', 'out', '.next', '.nuxt',
    '__pycache__', '.pytest_cache', '.mypy_cache',
    'venv', '.venv', 'env', '.env',
    '.idea', '.vscode', '.vs',
    'coverage', '.nyc_output',
    'target', 'pkg', 'vendor',
    '.turbo', '.cache',
]);
const ALWAYS_SKIP_FILES = new Set([
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    '.DS_Store', 'Thumbs.db',
]);
const MAX_FILE_SIZE = 500 * 1024; // 500KB
const MAX_FILES = 2000;
class WorkspaceIndexer {
    constructor(_outputChannel, storageUri) {
        this._outputChannel = _outputChannel;
        this._index = null;
        this._gitignorePatterns = [];
        this._fluxignorePatterns = [];
        this._imports = new Map(); // relPath → direct deps
        this._importedBy = new Map(); // relPath → dependents
        this._symbolToFiles = new Map(); // symbol → files that export it
        this._fileExports = new Map(); // relPath → exported symbol names
        this._transitiveDeps = new Map(); // relPath → all reachable deps (full closure)
        this._embeddings = new embedder_1.EmbeddingStore();
        this._voyageApiKey = '';
        this._recentEdits = new Map(); // relPath → timestamp ms
        this._storageUri = storageUri;
    }
    setVoyageApiKey(key) { this._voyageApiKey = key; }
    hasEmbeddings() { return this._embeddings.size > 0; }
    async semanticSearch(query, voyageApiKey) {
        return this._embeddings.multiHopSearch(query, voyageApiKey);
    }
    /**
     * Files edited (saved) within the given window, newest first.
     * Used as Layer-1 deterministic context — recently touched files are
     * almost always relevant to the current task.
     */
    getRecentlyEdited(withinMs = 30 * 60 * 1000) {
        const cutoff = Date.now() - withinMs;
        return [...this._recentEdits.entries()]
            .filter(([, ts]) => ts >= cutoff)
            .sort((a, b) => b[1] - a[1])
            .map(([relPath]) => relPath);
    }
    /**
     * Find indexed files whose basename matches the given name (case-insensitive).
     * Used to surface files the user mentions by name in their prompt.
     */
    findByName(filename) {
        if (!this._index) {
            return [];
        }
        const lower = filename.toLowerCase();
        return this._index.files
            .filter(f => path.basename(f.relPath).toLowerCase() === lower)
            .map(f => f.relPath.replace(/\\/g, '/'));
    }
    /** Load persisted index from workspace storage. Returns true if loaded. */
    async tryLoad() {
        if (!this._storageUri) {
            return false;
        }
        const cacheFile = vscode.Uri.joinPath(this._storageUri, 'index.json');
        try {
            const bytes = await vscode.workspace.fs.readFile(cacheFile);
            const data = JSON.parse(Buffer.from(bytes).toString('utf8'));
            // Only use cache if it matches the current workspace root
            const folders = vscode.workspace.workspaceFolders;
            if (!folders || folders[0].uri.fsPath !== data.root) {
                return false;
            }
            this._index = { root: data.root, files: data.files, builtAt: data.builtAt };
            // Restore all 4 maps from cache fields (with empty fallback for old caches)
            this._imports.clear();
            for (const [k, v] of Object.entries(data.graphImports ?? {})) {
                this._imports.set(k, v);
            }
            this._importedBy.clear();
            for (const [k, v] of Object.entries(data.graphImportedBy ?? {})) {
                this._importedBy.set(k, v);
            }
            this._fileExports.clear();
            for (const [k, v] of Object.entries(data.graphFileExports ?? {})) {
                this._fileExports.set(k, v);
            }
            this._symbolToFiles.clear();
            for (const [k, v] of Object.entries(data.graphSymbolToFiles ?? {})) {
                this._symbolToFiles.set(k, v);
            }
            // If old cache had no graph data, fall back to rebuilding symbol map from file entries
            if (!data.graphSymbolToFiles) {
                for (const file of data.files) {
                    const relPath = file.relPath.replace(/\\/g, '/');
                    for (const sym of file.symbols) {
                        const arr = this._symbolToFiles.get(sym) ?? [];
                        arr.push(relPath);
                        this._symbolToFiles.set(sym, arr);
                    }
                }
            }
            this._buildTransitiveClosure();
            this._outputChannel.appendLine(`[Indexer] Loaded cached index: ${data.files.length} files (built ${new Date(data.builtAt).toLocaleString()})`);
            if (this._storageUri) {
                await this._embeddings.tryLoad(this._storageUri);
            }
            return true;
        }
        catch {
            return false;
        }
    }
    async saveCache() {
        if (!this._storageUri || !this._index) {
            return;
        }
        try {
            await vscode.workspace.fs.createDirectory(this._storageUri);
            const cacheFile = vscode.Uri.joinPath(this._storageUri, 'index.json');
            const payload = {
                ...this._index,
                graphImports: Object.fromEntries(this._imports),
                graphImportedBy: Object.fromEntries(this._importedBy),
                graphFileExports: Object.fromEntries(this._fileExports),
                graphSymbolToFiles: Object.fromEntries(this._symbolToFiles),
            };
            await vscode.workspace.fs.writeFile(cacheFile, Buffer.from(JSON.stringify(payload), 'utf8'));
            this._outputChannel.appendLine(`[Indexer] Cache saved (${this._index.files.length} files)`);
            if (this._storageUri) {
                await this._embeddings.save(this._storageUri);
            }
        }
        catch (e) {
            this._outputChannel.appendLine(`[Indexer] Cache save failed: ${e}`);
        }
    }
    get index() {
        return this._index;
    }
    async build(onProgress) {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            throw new Error('No workspace folder open');
        }
        const root = folders[0].uri.fsPath;
        this._outputChannel.appendLine(`[Indexer] Scanning: ${root}`);
        // Load .gitignore and .fluxignore patterns
        this._gitignorePatterns = this._loadIgnoreFile(root, '.gitignore');
        this._fluxignorePatterns = this._loadIgnoreFile(root, '.fluxignore');
        // Collect all file paths
        const allPaths = [];
        this._walkDir(root, root, allPaths);
        this._outputChannel.appendLine(`[Indexer] Found ${allPaths.length} files`);
        // Clear all 4 maps before building
        this._imports.clear();
        this._importedBy.clear();
        this._symbolToFiles.clear();
        this._fileExports.clear();
        const files = [];
        let done = 0;
        for (const absPath of allPaths.slice(0, MAX_FILES)) {
            try {
                const entry = this._processFile(absPath, root);
                if (entry) {
                    files.push(entry);
                }
                this._indexFileIntoMaps(absPath, root);
            }
            catch {
                // skip unreadable files
            }
            done++;
            if (done % 20 === 0) {
                onProgress(done, allPaths.length);
                // Yield to event loop
                await new Promise((r) => setTimeout(r, 0));
            }
        }
        this._index = { root, files, builtAt: Date.now() };
        this._buildTransitiveClosure();
        this._outputChannel.appendLine(`[Indexer] Indexed ${files.length} files`);
        // Build embeddings if a Voyage API key is configured
        const voyageApiKey = vscode.workspace.getConfiguration('aiCowork').get('voyageApiKey') ?? '';
        if (voyageApiKey) {
            this._voyageApiKey = voyageApiKey;
            this._outputChannel.appendLine(`[Indexer] Building embeddings...`);
            const codeFiles = files
                .filter(f => (0, embedder_1.isEmbeddable)(f.ext))
                .map(f => ({ relPath: f.relPath, content: fs.readFileSync(f.absPath, 'utf8') }));
            try {
                await this._embeddings.buildFromFiles(codeFiles, voyageApiKey, (done, total) => {
                    onProgress(done, total);
                });
                this._outputChannel.appendLine(`[Indexer] Embeddings built: ${this._embeddings.size} chunks`);
            }
            catch (e) {
                this._outputChannel.appendLine(`[Indexer] Embedding build failed: ${e}`);
            }
        }
        void this.saveCache();
        return this._index;
    }
    _walkDir(dir, root, out) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const absPath = path.join(dir, entry.name);
            const relPath = path.relative(root, absPath);
            if (entry.isDirectory()) {
                if (ALWAYS_SKIP_DIRS.has(entry.name.toLowerCase())) {
                    continue;
                }
                if (entry.name.startsWith('.') && entry.name !== '.github') {
                    continue;
                }
                if (this._isGitignored(relPath, true)) {
                    continue;
                }
                if (this._isFluxignored(relPath, true)) {
                    continue;
                }
                this._walkDir(absPath, root, out);
            }
            else if (entry.isFile()) {
                if (ALWAYS_SKIP_FILES.has(entry.name)) {
                    continue;
                }
                if (this._isGitignored(relPath, false)) {
                    continue;
                }
                if (this._isFluxignored(relPath, false)) {
                    continue;
                }
                const ext = path.extname(entry.name).replace('.', '').toLowerCase();
                const baseLower = entry.name.toLowerCase();
                if (!SUPPORTED_EXTS.has(ext) && !SUPPORTED_EXTS.has(baseLower)) {
                    continue;
                }
                out.push(absPath);
            }
        }
    }
    _processFile(absPath, root) {
        const stat = fs.statSync(absPath);
        if (stat.size > MAX_FILE_SIZE) {
            return null;
        }
        const relPath = path.relative(root, absPath);
        const ext = path.extname(absPath).replace('.', '').toLowerCase();
        let content;
        try {
            content = fs.readFileSync(absPath, 'utf8');
        }
        catch {
            return null;
        }
        const lines = content.split('\n').length;
        const symbols = (0, symbolExtractor_1.extractSymbols)(content).symbols;
        return { absPath, relPath, ext, lines, symbols, size: stat.size };
    }
    // ─── Import + export graph ────────────────────────────────────────────────
    _indexFileIntoMaps(absPath, root) {
        let content;
        try {
            content = fs.readFileSync(absPath, 'utf8');
        }
        catch {
            return;
        }
        const relPath = path.relative(root, absPath).replace(/\\/g, '/');
        // Remove stale import edges
        const oldDeps = this._imports.get(relPath) ?? [];
        for (const dep of oldDeps) {
            const arr = this._importedBy.get(dep) ?? [];
            this._importedBy.set(dep, arr.filter(r => r !== relPath));
        }
        this._imports.delete(relPath);
        // Remove stale export entries
        const oldExports = this._fileExports.get(relPath) ?? [];
        for (const sym of oldExports) {
            const arr = this._symbolToFiles.get(sym) ?? [];
            this._symbolToFiles.set(sym, arr.filter(r => r !== relPath));
        }
        this._fileExports.delete(relPath);
        // Populate import edges
        const deps = (0, symbolExtractor_1.extractImports)(content, absPath, root);
        this._imports.set(relPath, deps);
        for (const dep of deps) {
            const arr = this._importedBy.get(dep) ?? [];
            if (!arr.includes(relPath)) {
                arr.push(relPath);
            }
            this._importedBy.set(dep, arr);
        }
        // Populate export maps
        const { exports: exportedSyms } = (0, symbolExtractor_1.extractSymbols)(content);
        this._fileExports.set(relPath, exportedSyms);
        for (const sym of exportedSyms) {
            const arr = this._symbolToFiles.get(sym) ?? [];
            if (!arr.includes(relPath)) {
                arr.push(relPath);
            }
            this._symbolToFiles.set(sym, arr);
        }
    }
    /** Files directly imported by the given file (one level). */
    getDependencies(relPath) {
        return this._imports.get(relPath.replace(/\\/g, '/')) ?? [];
    }
    /** Files that directly import the given file. */
    getDependents(relPath) {
        return this._importedBy.get(relPath.replace(/\\/g, '/')) ?? [];
    }
    /** Files that export (or define) the given symbol name. */
    getFilesExportingSymbol(symbol) {
        return this._symbolToFiles.get(symbol) ?? [];
    }
    /** Get the exported symbols for a given relative path. */
    getExportsForFile(relPath) {
        return this._fileExports.get(relPath.replace(/\\/g, '/')) ?? [];
    }
    /** All files reachable from relPath through any chain of imports (full transitive closure). */
    getTransitiveDeps(relPath) {
        return this._transitiveDeps.get(relPath.replace(/\\/g, '/')) ?? [];
    }
    /**
     * Pre-computes the full transitive import closure for every file.
     * Uses memoised DFS with cycle detection (circular imports return a partial result).
     * Call after build() or tryLoad() — not after every patchFile() (too expensive).
     */
    _buildTransitiveClosure() {
        this._transitiveDeps.clear();
        const inProgress = new Set();
        const dfs = (node) => {
            if (this._transitiveDeps.has(node)) {
                return this._transitiveDeps.get(node);
            }
            if (inProgress.has(node)) {
                return [];
            } // cycle edge — break
            inProgress.add(node);
            const all = new Set();
            for (const direct of this._imports.get(node) ?? []) {
                all.add(direct);
                for (const t of dfs(direct)) {
                    all.add(t);
                }
            }
            inProgress.delete(node);
            const result = [...all];
            this._transitiveDeps.set(node, result);
            return result;
        };
        for (const node of this._imports.keys()) {
            dfs(node);
        }
    }
    _loadIgnoreFile(root, filename) {
        const patterns = [];
        const gitignorePath = path.join(root, filename);
        if (!fs.existsSync(gitignorePath)) {
            return patterns;
        }
        try {
            const lines = fs.readFileSync(gitignorePath, 'utf8').split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) {
                    continue;
                }
                try {
                    // Convert glob pattern to regex (simplified)
                    const escaped = trimmed
                        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                        .replace(/\*/g, '[^/]*')
                        .replace(/\?/g, '[^/]');
                    patterns.push(new RegExp(`(^|/)${escaped}($|/)`));
                }
                catch {
                    // skip invalid pattern
                }
            }
        }
        catch {
            // ignore
        }
        return patterns;
    }
    _isGitignored(relPath, isDir) {
        const normalized = relPath.replace(/\\/g, '/');
        const checkPath = isDir ? normalized + '/' : normalized;
        return this._gitignorePatterns.some((p) => p.test(checkPath));
    }
    _isFluxignored(relPath, isDir) {
        const normalized = relPath.replace(/\\/g, '/');
        const checkPath = isDir ? normalized + '/' : normalized;
        return this._fluxignorePatterns.some((p) => p.test(checkPath));
    }
    /** Returns true if the given relative path matches a .fluxignore pattern */
    isFluxignored(relPath, isDir = false) {
        return this._isFluxignored(relPath, isDir);
    }
    /** Patch a single file entry in the index (called on file save) */
    patchFile(absPath) {
        if (!this._index) {
            return;
        }
        const root = this._index.root;
        const relPath = path.relative(root, absPath).replace(/\\/g, '/');
        const existing = this._index.files.findIndex((f) => f.absPath === absPath);
        try {
            const entry = this._processFile(absPath, root);
            if (!entry) {
                return;
            }
            if (existing >= 0) {
                this._index.files[existing] = entry;
            }
            else {
                this._index.files.push(entry);
            }
            this._indexFileIntoMaps(absPath, root);
            this._rebuildTransitiveFor(relPath);
            // Record edit timestamp for recently-edited Layer-1 discovery
            this._recentEdits.set(relPath, Date.now());
            if (this._recentEdits.size > 50) {
                // Evict the oldest entry to cap memory
                const oldest = [...this._recentEdits.entries()].sort((a, b) => a[1] - b[1])[0];
                this._recentEdits.delete(oldest[0]);
            }
            // Fire-and-forget embedding update — does not block file save
            if (this._voyageApiKey && (0, embedder_1.isEmbeddable)(path.extname(absPath))) {
                void this._patchEmbeddingsAsync(absPath, relPath);
            }
        }
        catch {
            if (existing >= 0) {
                this._index.files.splice(existing, 1);
            }
        }
    }
    async _patchEmbeddingsAsync(absPath, relPath) {
        try {
            const content = fs.readFileSync(absPath, 'utf8');
            await this._embeddings.patchFile(relPath, content, this._voyageApiKey);
        }
        catch (e) {
            this._outputChannel.appendLine(`[Indexer] Embedding patch failed for ${relPath}: ${e}`);
        }
    }
    /**
     * Incrementally updates the transitive closure after a single file is patched.
     * Only the patched file and its ancestors (files that transitively import it)
     * can have a stale closure — everything else is unaffected and stays cached.
     */
    _rebuildTransitiveFor(relPath) {
        // BFS over _importedBy to find every file whose closure might have changed
        const affected = new Set([relPath]);
        const queue = [relPath];
        while (queue.length > 0) {
            const node = queue.shift();
            for (const parent of this._importedBy.get(node) ?? []) {
                if (!affected.has(parent)) {
                    affected.add(parent);
                    queue.push(parent);
                }
            }
        }
        // Drop stale entries so the DFS below recomputes them fresh
        for (const node of affected) {
            this._transitiveDeps.delete(node);
        }
        // Recompute using the same memoised DFS as _buildTransitiveClosure.
        // Non-affected nodes still have valid cached entries that are reused directly.
        const inProgress = new Set();
        const dfs = (node) => {
            if (this._transitiveDeps.has(node)) {
                return this._transitiveDeps.get(node);
            }
            if (inProgress.has(node)) {
                return [];
            } // cycle — break
            inProgress.add(node);
            const all = new Set();
            for (const direct of this._imports.get(node) ?? []) {
                all.add(direct);
                for (const t of dfs(direct)) {
                    all.add(t);
                }
            }
            inProgress.delete(node);
            const result = [...all];
            this._transitiveDeps.set(node, result);
            return result;
        };
        for (const node of affected) {
            dfs(node);
        }
    }
    /** Build a compact file tree string for Claude's context */
    buildTreeString() {
        if (!this._index) {
            return '(not indexed)';
        }
        const { files, root } = this._index;
        const lines = [`Workspace: ${path.basename(root)}`, ''];
        // Group by top-level directory
        const groups = new Map();
        for (const f of files) {
            const parts = f.relPath.replace(/\\/g, '/').split('/');
            const topDir = parts.length > 1 ? parts[0] : '.';
            if (!groups.has(topDir)) {
                groups.set(topDir, []);
            }
            groups.get(topDir).push(f);
        }
        for (const [dir, entries] of groups) {
            lines.push(`📁 ${dir}/`);
            for (const e of entries.slice(0, 40)) {
                const name = path.basename(e.relPath);
                const symbolsStr = e.symbols.length > 0
                    ? ` [${e.symbols.slice(0, 5).join(', ')}]`
                    : '';
                lines.push(`  ${name} (${e.lines}L)${symbolsStr}`);
            }
            if (entries.length > 40) {
                lines.push(`  ... and ${entries.length - 40} more files`);
            }
            lines.push('');
        }
        lines.push(`Total: ${files.length} files`);
        return lines.join('\n');
    }
    /** Build an annotated file tree that shows exported symbols next to each path */
    buildAnnotatedTree() {
        if (!this._index) {
            return '(not indexed)';
        }
        const { files, root } = this._index;
        const lines = [`Workspace: ${path.basename(root)}`, ''];
        // Group by top-level directory
        const groups = new Map();
        for (const f of files) {
            const parts = f.relPath.replace(/\\/g, '/').split('/');
            const topDir = parts.length > 1 ? parts[0] : '.';
            if (!groups.has(topDir)) {
                groups.set(topDir, []);
            }
            groups.get(topDir).push(f);
        }
        for (const [dir, entries] of groups) {
            lines.push(`📁 ${dir}/`);
            for (const e of entries.slice(0, 40)) {
                const relPosix = e.relPath.replace(/\\/g, '/');
                const name = path.basename(e.relPath);
                const fileExports = this._fileExports.get(relPosix) ?? [];
                const exportsStr = fileExports.length > 0
                    ? ` [${fileExports.slice(0, 5).join(', ')}]`
                    : '';
                lines.push(`  ${name} (${e.lines}L)${exportsStr}`);
            }
            if (entries.length > 40) {
                lines.push(`  ... and ${entries.length - 40} more files`);
            }
            lines.push('');
        }
        lines.push(`Total: ${files.length} files`);
        return lines.join('\n');
    }
    /** Resolve a relative path to absolute */
    resolveRelPath(relPath) {
        if (!this._index) {
            return null;
        }
        const abs = path.join(this._index.root, relPath);
        return abs;
    }
    getRoot() {
        return this._index?.root ?? null;
    }
}
exports.WorkspaceIndexer = WorkspaceIndexer;
//# sourceMappingURL=indexer.js.map