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
        this._namedImports = new Map(); // relPath → { symbolName → sourceRelPath }
        this._keywordToFiles = new Map(); // keyword → files containing it
        this._symbolImporters = new Map(); // "sym@srcRelPath" → files that import sym from srcRelPath
        this._storageUri = storageUri;
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
            // Backfill fields added after initial cache version
            for (const f of data.files) {
                if (!f.language) {
                    f.language = (0, symbolExtractor_1.detectLanguage)(f.ext);
                }
                if (!f.modifiedAt) {
                    f.modifiedAt = 0;
                }
                if (!f.symbolMeta) {
                    f.symbolMeta = { functions: [], classes: [] };
                }
                if (!f.keywords) {
                    f.keywords = [];
                }
                if (f.large === undefined) {
                    f.large = false;
                }
                if (f.baseScore === undefined) {
                    f.baseScore = 0;
                }
            }
            this._index = { root: data.root, files: data.files, builtAt: data.builtAt };
            // Restore maps from cache fields (with empty fallback for old caches)
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
            this._namedImports.clear();
            for (const [k, v] of Object.entries(data.graphNamedImports ?? {})) {
                this._namedImports.set(k, v);
            }
            // If old cache had no graph data, rebuild symbol map from file entries
            if (!data.graphSymbolToFiles) {
                for (const file of data.files) {
                    const rel = file.relPath.replace(/\\/g, '/');
                    for (const sym of file.symbols) {
                        const arr = this._symbolToFiles.get(sym) ?? [];
                        arr.push(rel);
                        this._symbolToFiles.set(sym, arr);
                    }
                }
            }
            // Rebuild derived maps (not persisted) from loaded data
            this._keywordToFiles.clear();
            for (const file of data.files) {
                const rel = file.relPath.replace(/\\/g, '/');
                for (const kw of file.keywords ?? []) {
                    const arr = this._keywordToFiles.get(kw) ?? [];
                    arr.push(rel);
                    this._keywordToFiles.set(kw, arr);
                }
            }
            this._symbolImporters.clear();
            for (const [rel, namedMap] of this._namedImports) {
                for (const [sym, src] of Object.entries(namedMap)) {
                    const key = `${sym}@${src}`;
                    const arr = this._symbolImporters.get(key) ?? [];
                    arr.push(rel);
                    this._symbolImporters.set(key, arr);
                }
            }
            this._buildTransitiveClosure();
            this._outputChannel.appendLine(`[Indexer] Loaded cached index: ${data.files.length} files (built ${new Date(data.builtAt).toLocaleString()})`);
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
                graphNamedImports: Object.fromEntries(this._namedImports),
            };
            await vscode.workspace.fs.writeFile(cacheFile, Buffer.from(JSON.stringify(payload), 'utf8'));
            this._outputChannel.appendLine(`[Indexer] Cache saved (${this._index.files.length} files)`);
        }
        catch (e) {
            this._outputChannel.appendLine(`[Indexer] Cache save failed: ${e}`);
        }
    }
    get index() {
        return this._index;
    }
    /**
     * Build (or incrementally refresh) the workspace index.
     *
     * incremental = true  — reuse cached entries whose mtime hasn't changed;
     *                       only process new/modified files and clean up deleted ones.
     *                       Falls back to a full build if no index is loaded yet.
     * incremental = false — clear all maps and process every file from scratch.
     */
    async build(onProgress, incremental = false) {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            throw new Error('No workspace folder open');
        }
        const root = folders[0].uri.fsPath;
        this._outputChannel.appendLine(`[Indexer] Scanning: ${root}`);
        this._gitignorePatterns = this._loadIgnoreFile(root, '.gitignore');
        this._fluxignorePatterns = this._loadIgnoreFile(root, '.fluxignore');
        const allPaths = [];
        this._walkDir(root, root, allPaths);
        this._outputChannel.appendLine(`[Indexer] Found ${allPaths.length} files`);
        // ── Incremental setup ────────────────────────────────────────────────────
        const useIncremental = incremental && this._index !== null;
        const prevEntries = new Map(useIncremental ? this._index.files.map(f => [f.absPath, f]) : []);
        if (!useIncremental) {
            this._imports.clear();
            this._importedBy.clear();
            this._symbolToFiles.clear();
            this._fileExports.clear();
            this._namedImports.clear();
            this._keywordToFiles.clear();
            this._symbolImporters.clear();
        }
        const files = [];
        const seenAbsPaths = new Set();
        let done = 0;
        let reused = 0;
        let updated = 0;
        for (const absPath of allPaths.slice(0, MAX_FILES)) {
            seenAbsPaths.add(absPath);
            try {
                if (useIncremental) {
                    const cached = prevEntries.get(absPath);
                    if (cached) {
                        let stat;
                        try {
                            stat = fs.statSync(absPath);
                        }
                        catch {
                            done++;
                            if (done % 20 === 0) {
                                onProgress(done, allPaths.length);
                                await new Promise(r => setTimeout(r, 0));
                            }
                            continue;
                        }
                        if (Math.abs(stat.mtimeMs - cached.modifiedAt) < 1) {
                            // Unchanged — keep cached entry; maps already correct
                            files.push(cached);
                            reused++;
                            done++;
                            if (done % 20 === 0) {
                                onProgress(done, allPaths.length);
                                await new Promise(r => setTimeout(r, 0));
                            }
                            continue;
                        }
                    }
                }
                const entry = this._processAndIndex(absPath, root);
                if (entry) {
                    files.push(entry);
                    updated++;
                }
            }
            catch {
                // skip unreadable files
            }
            done++;
            if (done % 20 === 0) {
                onProgress(done, allPaths.length);
                await new Promise((r) => setTimeout(r, 0));
            }
        }
        // Remove stale map entries for files that disappeared from disk
        if (useIncremental) {
            for (const [absPath, entry] of prevEntries) {
                if (!seenAbsPaths.has(absPath)) {
                    this._removeFromMaps(entry.relPath.replace(/\\/g, '/'));
                }
            }
        }
        // Post-pass: compute baseScore (numExports + numImports + importedByCount)
        for (const f of files) {
            const rel = f.relPath.replace(/\\/g, '/');
            f.baseScore = (this._fileExports.get(rel) ?? []).length
                + (this._imports.get(rel) ?? []).length
                + (this._importedBy.get(rel) ?? []).length;
        }
        this._index = { root, files, builtAt: Date.now() };
        this._buildTransitiveClosure();
        this._outputChannel.appendLine(useIncremental
            ? `[Indexer] Re-indexed: ${updated} updated, ${reused} unchanged (${files.length} total)`
            : `[Indexer] Indexed ${files.length} files`);
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
    // ─── Single-read file processor ──────────────────────────────────────────
    /**
     * Reads the file ONCE, produces a FileEntry, and updates all index maps.
     *
     * Size tiers:
     *   > 1 MB   → skip entirely (return null)
     *   > 500 KB → mark large:true; index imports/exports, skip symbolMeta/keywords
     *   ≤ 500 KB → full analysis
     */
    _processAndIndex(absPath, root) {
        let stat;
        try {
            stat = fs.statSync(absPath);
        }
        catch {
            return null;
        }
        if (stat.size > 2 * MAX_FILE_SIZE) {
            return null;
        } // hard skip above 1 MB
        const relPath = path.relative(root, absPath);
        const relPosix = relPath.replace(/\\/g, '/');
        const ext = path.extname(absPath).replace('.', '').toLowerCase();
        const large = stat.size > MAX_FILE_SIZE;
        let content;
        try {
            content = fs.readFileSync(absPath, 'utf8');
        }
        catch {
            return null;
        }
        // ── FileEntry fields ──────────────────────────────────────────────────
        const lines = content.split('\n').length;
        const { symbols, exports: exportedSyms } = (0, symbolExtractor_1.extractSymbols)(content, ext);
        const language = (0, symbolExtractor_1.detectLanguage)(ext);
        const modifiedAt = stat.mtimeMs;
        const symbolMeta = large ? { functions: [], classes: [] } : (0, symbolExtractor_1.extractSymbolMeta)(content, ext);
        const keywords = large ? [] : (0, symbolExtractor_1.extractKeywords)(content, relPath);
        // ── Stale-edge removal (no-op on first full build) ────────────────────
        const oldDeps = this._imports.get(relPosix) ?? [];
        for (const dep of oldDeps) {
            const arr = this._importedBy.get(dep) ?? [];
            this._importedBy.set(dep, arr.filter(r => r !== relPosix));
        }
        this._imports.delete(relPosix);
        const oldExports = this._fileExports.get(relPosix) ?? [];
        for (const sym of oldExports) {
            const arr = this._symbolToFiles.get(sym) ?? [];
            this._symbolToFiles.set(sym, arr.filter(r => r !== relPosix));
        }
        this._fileExports.delete(relPosix);
        // Remove old keyword associations
        const oldEntry = this._index?.files.find(f => f.relPath.replace(/\\/g, '/') === relPosix);
        for (const kw of oldEntry?.keywords ?? []) {
            const arr = this._keywordToFiles.get(kw) ?? [];
            this._keywordToFiles.set(kw, arr.filter(r => r !== relPosix));
        }
        // Remove old symbol-importer associations
        const oldNamed = this._namedImports.get(relPosix) ?? {};
        for (const [sym, src] of Object.entries(oldNamed)) {
            const key = `${sym}@${src}`;
            const arr = this._symbolImporters.get(key) ?? [];
            this._symbolImporters.set(key, arr.filter(r => r !== relPosix));
        }
        // ── Write new edges ───────────────────────────────────────────────────
        const deps = (0, symbolExtractor_1.extractImports)(content, absPath, root);
        this._imports.set(relPosix, deps);
        for (const dep of deps) {
            const arr = this._importedBy.get(dep) ?? [];
            if (!arr.includes(relPosix)) {
                arr.push(relPosix);
            }
            this._importedBy.set(dep, arr);
        }
        const named = (0, symbolExtractor_1.extractNamedImports)(content, absPath, root);
        if (named.length > 0) {
            const namedEntry = {};
            for (const { symbol, sourceRelPath } of named) {
                namedEntry[symbol] = sourceRelPath;
            }
            this._namedImports.set(relPosix, namedEntry);
            for (const { symbol, sourceRelPath } of named) {
                const key = `${symbol}@${sourceRelPath}`;
                const arr = this._symbolImporters.get(key) ?? [];
                if (!arr.includes(relPosix)) {
                    arr.push(relPosix);
                }
                this._symbolImporters.set(key, arr);
            }
        }
        else {
            this._namedImports.delete(relPosix);
        }
        this._fileExports.set(relPosix, exportedSyms);
        for (const sym of exportedSyms) {
            const arr = this._symbolToFiles.get(sym) ?? [];
            if (!arr.includes(relPosix)) {
                arr.push(relPosix);
            }
            this._symbolToFiles.set(sym, arr);
        }
        for (const kw of keywords) {
            const arr = this._keywordToFiles.get(kw) ?? [];
            if (!arr.includes(relPosix)) {
                arr.push(relPosix);
            }
            this._keywordToFiles.set(kw, arr);
        }
        // baseScore filled by post-pass after all files are indexed
        return { absPath, relPath, ext, lines, symbols, size: stat.size, large, language, modifiedAt, symbolMeta, keywords, baseScore: 0 };
    }
    // ─── Map cleanup helper ────────────────────────────────────────────────────
    /**
     * Removes all map entries for a file. Used by deleteFile() and the incremental
     * build's stale-entry cleanup.
     */
    _removeFromMaps(relPosix) {
        // outgoing import edges
        const deps = this._imports.get(relPosix) ?? [];
        for (const dep of deps) {
            const arr = this._importedBy.get(dep) ?? [];
            this._importedBy.set(dep, arr.filter(r => r !== relPosix));
        }
        this._imports.delete(relPosix);
        // export symbol entries
        const exps = this._fileExports.get(relPosix) ?? [];
        for (const sym of exps) {
            const arr = this._symbolToFiles.get(sym) ?? [];
            this._symbolToFiles.set(sym, arr.filter(r => r !== relPosix));
        }
        this._fileExports.delete(relPosix);
        // this file as a dependency target
        this._importedBy.delete(relPosix);
        // named import symbol-importer entries
        const namedMap = this._namedImports.get(relPosix) ?? {};
        for (const [sym, src] of Object.entries(namedMap)) {
            const key = `${sym}@${src}`;
            const arr = this._symbolImporters.get(key) ?? [];
            this._symbolImporters.set(key, arr.filter(r => r !== relPosix));
        }
        this._namedImports.delete(relPosix);
        // keyword entries (read from FileEntry while it's still in _index.files)
        const entry = this._index?.files.find(f => f.relPath.replace(/\\/g, '/') === relPosix);
        for (const kw of entry?.keywords ?? []) {
            const arr = this._keywordToFiles.get(kw) ?? [];
            this._keywordToFiles.set(kw, arr.filter(r => r !== relPosix));
        }
        this._transitiveDeps.delete(relPosix);
    }
    // ─── Public mutation API ──────────────────────────────────────────────────
    /** Patch a single file entry in the index (called on file save). */
    patchFile(absPath) {
        if (!this._index) {
            return;
        }
        const root = this._index.root;
        const relPath = path.relative(root, absPath).replace(/\\/g, '/');
        const existing = this._index.files.findIndex((f) => f.absPath === absPath);
        try {
            const entry = this._processAndIndex(absPath, root);
            if (!entry) {
                return;
            }
            entry.baseScore = (this._fileExports.get(relPath) ?? []).length
                + (this._imports.get(relPath) ?? []).length
                + (this._importedBy.get(relPath) ?? []).length;
            if (existing >= 0) {
                this._index.files[existing] = entry;
            }
            else {
                this._index.files.push(entry);
            }
            this._rebuildTransitiveFor(relPath);
        }
        catch {
            if (existing >= 0) {
                this._index.files.splice(existing, 1);
            }
        }
    }
    /** Remove a deleted file from the index and all dependency maps. */
    deleteFile(absPath) {
        if (!this._index) {
            return;
        }
        const root = this._index.root;
        const relPath = path.relative(root, absPath).replace(/\\/g, '/');
        const idx = this._index.files.findIndex(f => f.absPath === absPath);
        if (idx < 0) {
            return;
        }
        // Remove from maps BEFORE splicing (so _removeFromMaps can still find the entry)
        this._removeFromMaps(relPath);
        this._index.files.splice(idx, 1);
        this._rebuildTransitiveFor(relPath);
    }
    // ─── Query API ─────────────────────────────────────────────────────────────
    /** Files directly imported by the given file (one level). */
    getDependencies(relPath) {
        return this._imports.get(relPath.replace(/\\/g, '/')) ?? [];
    }
    /** Files that directly import the given file. */
    getDependents(relPath) {
        return this._importedBy.get(relPath.replace(/\\/g, '/')) ?? [];
    }
    /**
     * Returns dependency metadata for a file:
     *   imports:    module-dot-notation paths this file imports
     *   importedBy: module-dot-notation paths that import this file
     */
    getDependencyMetadata(relPath) {
        const toModule = (p) => p.replace(/\.[^.]+$/, '').replace(/[/\\]/g, '.');
        const key = relPath.replace(/\\/g, '/');
        return {
            imports: (this._imports.get(key) ?? []).map(toModule),
            importedBy: (this._importedBy.get(key) ?? []).map(toModule),
        };
    }
    /** All files reachable from relPath through any chain of imports. */
    getTransitiveDeps(relPath) {
        return this._transitiveDeps.get(relPath.replace(/\\/g, '/')) ?? [];
    }
    /**
     * DFS traversal of the import graph starting from startRelPath.
     *   direction 'deps'       — follows outgoing import edges (what this file uses)
     *   direction 'dependents' — follows incoming edges (what imports this file)
     * Returns visited files in DFS visit order (excluding the start file itself),
     * each paired with its depth so callers can weight by distance.
     */
    dfsTraversal(startRelPath, direction = 'deps', maxDepth = 5) {
        const start = startRelPath.replace(/\\/g, '/');
        const visited = new Set();
        const result = [];
        const dfs = (relPath, depth) => {
            if (visited.has(relPath) || depth > maxDepth) {
                return;
            }
            visited.add(relPath);
            if (relPath !== start) {
                result.push({ relPath, depth });
            }
            const neighbors = direction === 'deps'
                ? (this._imports.get(relPath) ?? [])
                : (this._importedBy.get(relPath) ?? []);
            for (const neighbor of neighbors) {
                dfs(neighbor, depth + 1);
            }
        };
        dfs(start, 0);
        return result;
    }
    /**
     * Score a candidate file for relevance to the current traversal step.
     *
     * Signal breakdown:
     *   +5  file exports a symbol that appears in the query tokens
     *   +4  the "via" file has a named import of a query token FROM this candidate
     *         (symbol-level precision — the exact symbol being used)
     *   +2  file's keyword list contains a query token
     *   +½  hub boost: log(baseScore) * 0.5 — central files are broadly relevant
     *   ÷d  depth penalty: divide total by depth so deeper files score lower
     */
    _scoreCandidate(relPath, lowerTokens, via, depth) {
        const key = relPath.replace(/\\/g, '/');
        let score = 1.5; // base — every direct neighbor gets at least this
        // Symbol match: candidate exports a query token
        for (const token of lowerTokens) {
            // Try exact, PascalCase, and camelCase variants
            for (const variant of [token, token[0].toUpperCase() + token.slice(1)]) {
                if ((this._symbolToFiles.get(variant) ?? []).includes(key)) {
                    score += 5;
                    break;
                }
            }
        }
        // Named import precision: "via" file does `import { token } from candidate`
        const namedMap = this._namedImports.get(via.replace(/\\/g, '/')) ?? {};
        for (const [sym, src] of Object.entries(namedMap)) {
            if (src === key && lowerTokens.some(t => t === sym.toLowerCase())) {
                score += 4;
            }
        }
        // Keyword match: candidate's keyword list overlaps with query tokens
        for (const token of lowerTokens) {
            if ((this._keywordToFiles.get(token) ?? []).includes(key)) {
                score += 2;
            }
        }
        // Hub boost: files imported by many others are broadly relevant
        const entry = this._index?.files.find(f => f.relPath.replace(/\\/g, '/') === key);
        if (entry?.baseScore) {
            score += Math.log1p(entry.baseScore) * 0.5;
        }
        // Depth penalty
        return score / depth;
    }
    /** Collect neighbors of `relPath` in the given direction and enqueue them. */
    _addNeighbors(relPath, depth, direction, enqueue) {
        const key = relPath.replace(/\\/g, '/');
        if (direction === 'forward' || direction === 'both') {
            // Regular import edges
            for (const dep of this._imports.get(key) ?? []) {
                enqueue(dep, depth, key, 'import');
            }
            // Named import edges — finer-grained: which exact symbol was imported
            for (const src of new Set(Object.values(this._namedImports.get(key) ?? {}))) {
                enqueue(src, depth, key, 'namedImport');
            }
        }
        if (direction === 'reverse' || direction === 'both') {
            for (const caller of this._importedBy.get(key) ?? []) {
                enqueue(caller, depth, key, 'importedBy');
            }
        }
    }
    /**
     * Guided best-first traversal of the import graph.
     *
     * Unlike naive DFS (stack) or BFS (queue), this maintains a priority queue
     * and always expands the highest-relevance neighbor next. This means:
     *   - Relevant files are found first, irrelevant chains are pruned early
     *   - maxFiles cap wastes no slots on low-signal files
     *   - Works in both forward (deps) and reverse (dependents) directions
     *
     * @param entryPaths   Starting files (already selected by the LLM)
     * @param queryTokens  Tokens extracted from the user prompt — drive scoring
     * @param opts.direction  'forward' | 'reverse' | 'both'
     * @param opts.maxDepth   Max hops from any entry file (default 3)
     * @param opts.maxFiles   Max files to return (default 8)
     */
    guidedTraversal(entryPaths, queryTokens, opts = {}) {
        const { direction = 'forward', maxDepth = 3, maxFiles = 8 } = opts;
        const lowerTokens = queryTokens.map(t => t.toLowerCase()).filter(t => t.length >= 3);
        const visited = new Set(entryPaths.map(p => p.replace(/\\/g, '/')));
        const results = [];
        // Priority queue — sorted by score descending (highest first)
        const pq = [];
        const enqueue = (relPath, depth, via, edgeType) => {
            const key = relPath.replace(/\\/g, '/');
            if (visited.has(key) || depth > maxDepth) {
                return;
            }
            const score = this._scoreCandidate(key, lowerTokens, via, depth);
            const item = { relPath: key, depth, score, via, edgeType };
            // Sorted insert — O(n) but graph is small
            let i = 0;
            while (i < pq.length && pq[i].score >= score) {
                i++;
            }
            pq.splice(i, 0, item);
        };
        // Seed the queue from all entry paths
        for (const entry of entryPaths) {
            this._addNeighbors(entry, 1, direction, enqueue);
        }
        while (pq.length > 0 && results.length < maxFiles) {
            const node = pq.shift(); // pop highest-score item
            if (visited.has(node.relPath)) {
                continue;
            }
            visited.add(node.relPath);
            results.push(node);
            // Expand: add this node's neighbors to the queue
            this._addNeighbors(node.relPath, node.depth + 1, direction, enqueue);
        }
        return results;
    }
    /** Global symbol index: every exported symbol → the files that define it. */
    getGlobalSymbolIndex() {
        return Object.fromEntries(this._symbolToFiles);
    }
    /** Named imports for a file: which symbol came from which source file. */
    getNamedImports(relPath) {
        return this._namedImports.get(relPath.replace(/\\/g, '/')) ?? {};
    }
    /** Files that export (or define) the given symbol name. */
    getFilesExportingSymbol(symbol) {
        return this._symbolToFiles.get(symbol) ?? [];
    }
    /** Fast-path symbol → files lookup (alias for getFilesExportingSymbol). */
    getFilesBySymbol(name) {
        return this._symbolToFiles.get(name) ?? [];
    }
    /**
     * Files that import the given symbol, optionally restricted to a specific source file.
     * e.g. getImportersOfSymbol("processPayment", "services/payment.ts")
     *      → files that do `import { processPayment } from './services/payment'`
     */
    getImportersOfSymbol(symbol, fromRelPath) {
        if (fromRelPath) {
            return this._symbolImporters.get(`${symbol}@${fromRelPath.replace(/\\/g, '/')}`) ?? [];
        }
        // Without a source filter: union across all source files for this symbol
        const result = [];
        const prefix = `${symbol}@`;
        for (const [key, files] of this._symbolImporters) {
            if (key.startsWith(prefix)) {
                for (const f of files) {
                    if (!result.includes(f)) {
                        result.push(f);
                    }
                }
            }
        }
        return result;
    }
    /** Files whose keyword list contains the exact term. */
    getFilesByKeyword(term) {
        return this._keywordToFiles.get(term) ?? [];
    }
    /**
     * Files that match any of the given terms.
     * Returned sorted by number of matching terms (descending).
     */
    searchFiles(terms) {
        const hits = new Map();
        for (const term of terms) {
            for (const rel of this._keywordToFiles.get(term) ?? []) {
                hits.set(rel, (hits.get(rel) ?? 0) + 1);
            }
        }
        return [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([rel]) => rel);
    }
    /** The exported symbols for a given relative path. */
    getExportsForFile(relPath) {
        return this._fileExports.get(relPath.replace(/\\/g, '/')) ?? [];
    }
    /**
     * Returns the source lines for a named symbol plus optional surrounding context.
     * Looks up the symbol in the global index, finds its line range from symbolMeta,
     * then reads the file. Returns null if the symbol or its range is unknown.
     */
    getFunctionContext(symbolName, contextLines = 10) {
        if (!this._index) {
            return null;
        }
        const candidates = this._symbolToFiles.get(symbolName) ?? [];
        if (candidates.length === 0) {
            return null;
        }
        const relPath = candidates[0];
        const entry = this._index.files.find(f => f.relPath.replace(/\\/g, '/') === relPath);
        if (!entry) {
            return null;
        }
        const sym = entry.symbolMeta.functions.find(f => f.name === symbolName) ??
            entry.symbolMeta.classes.find(c => c.name === symbolName);
        if (!sym) {
            return null;
        }
        const absPath = path.join(this._index.root, relPath);
        let fileContent;
        try {
            fileContent = fs.readFileSync(absPath, 'utf8');
        }
        catch {
            return null;
        }
        const lines = fileContent.split('\n');
        const startIdx = Math.max(0, sym.lineStart - 1 - contextLines);
        const endIdx = Math.min(lines.length, sym.lineEnd + contextLines);
        return {
            relPath,
            lineStart: startIdx + 1,
            lineEnd: endIdx,
            content: lines.slice(startIdx, endIdx).join('\n'),
        };
    }
    /**
     * Returns the files most related to the given file, ranked by a composite score:
     *   +5 per direct import / importedBy edge
     *   +3 per shared keyword
     *   +2 if in the same directory
     *   +1 per exported symbol that shares a name-prefix with this file's exports
     *   +log1p(baseScore) hub boost
     */
    getRelatedFiles(relPath, limit = 20) {
        if (!this._index) {
            return [];
        }
        const rel = relPath.replace(/\\/g, '/');
        const scored = new Map();
        const add = (r, pts) => {
            if (r === rel) {
                return;
            }
            const entry = this._index.files.find(f => f.relPath.replace(/\\/g, '/') === r);
            const boost = entry && entry.baseScore > 0 ? Math.log1p(entry.baseScore) : 0;
            scored.set(r, (scored.get(r) ?? 0) + pts + boost);
        };
        // Direct edges
        for (const dep of this._imports.get(rel) ?? []) {
            add(dep, 5);
        }
        for (const dep of this._importedBy.get(rel) ?? []) {
            add(dep, 5);
        }
        const entry = this._index.files.find(f => f.relPath.replace(/\\/g, '/') === rel);
        if (entry) {
            // Shared keywords
            for (const kw of entry.keywords) {
                for (const other of this._keywordToFiles.get(kw) ?? []) {
                    add(other, 3);
                }
            }
            // Same directory
            const dir = rel.includes('/') ? rel.replace(/\/[^/]+$/, '') : '';
            for (const f of this._index.files) {
                const fRel = f.relPath.replace(/\\/g, '/');
                const fDir = fRel.includes('/') ? fRel.replace(/\/[^/]+$/, '') : '';
                if (fDir === dir && fRel !== rel) {
                    add(fRel, 2);
                }
            }
            // Shared symbol name-prefix (first camelCase token, ≥3 chars)
            const myExports = this._fileExports.get(rel) ?? [];
            for (const sym of myExports) {
                const prefix = sym.replace(/([A-Z])/g, ' $1').trim().split(' ')[0].toLowerCase();
                if (prefix.length < 3) {
                    continue;
                }
                for (const [sym2, files2] of this._symbolToFiles) {
                    if (sym2 !== sym && sym2.toLowerCase().startsWith(prefix)) {
                        for (const f of files2) {
                            add(f, 1);
                        }
                    }
                }
            }
        }
        return [...scored.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([r]) => r);
    }
    // ─── Transitive closure ────────────────────────────────────────────────────
    /**
     * Pre-computes the full transitive import closure for every file.
     * Uses memoised DFS; on a back-edge (cycle), returns the actual cycle members
     * rather than an empty array so ancestors see the full reachable set.
     */
    _buildTransitiveClosure() {
        this._transitiveDeps.clear();
        const dfs = (node, stack) => {
            if (this._transitiveDeps.has(node)) {
                return this._transitiveDeps.get(node);
            }
            const cycleIdx = stack.lastIndexOf(node);
            if (cycleIdx !== -1) {
                return stack.slice(cycleIdx);
            } // return actual cycle members
            stack.push(node);
            const all = new Set();
            for (const direct of this._imports.get(node) ?? []) {
                all.add(direct);
                for (const t of dfs(direct, stack)) {
                    all.add(t);
                }
            }
            stack.pop();
            const result = [...all];
            this._transitiveDeps.set(node, result);
            return result;
        };
        for (const node of this._imports.keys()) {
            dfs(node, []);
        }
    }
    /**
     * Incrementally updates the transitive closure after a single file is patched or deleted.
     * Only the affected file and its ancestors (files that transitively import it) are recomputed.
     */
    _rebuildTransitiveFor(relPath) {
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
        for (const node of affected) {
            this._transitiveDeps.delete(node);
        }
        const dfs = (node, stack) => {
            if (this._transitiveDeps.has(node)) {
                return this._transitiveDeps.get(node);
            }
            const cycleIdx = stack.lastIndexOf(node);
            if (cycleIdx !== -1) {
                return stack.slice(cycleIdx);
            }
            stack.push(node);
            const all = new Set();
            for (const direct of this._imports.get(node) ?? []) {
                all.add(direct);
                for (const t of dfs(direct, stack)) {
                    all.add(t);
                }
            }
            stack.pop();
            const result = [...all];
            this._transitiveDeps.set(node, result);
            return result;
        };
        for (const node of affected) {
            dfs(node, []);
        }
    }
    // ─── Ignore helpers ────────────────────────────────────────────────────────
    _loadIgnoreFile(root, filename) {
        const patterns = [];
        const filePath = path.join(root, filename);
        if (!fs.existsSync(filePath)) {
            return patterns;
        }
        try {
            const lines = fs.readFileSync(filePath, 'utf8').split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) {
                    continue;
                }
                try {
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
    /** Returns true if the given relative path matches a .fluxignore pattern. */
    isFluxignored(relPath, isDir = false) {
        return this._isFluxignored(relPath, isDir);
    }
    // ─── Tree / display helpers ────────────────────────────────────────────────
    /** Build a compact file tree string for Claude's context. */
    buildTreeString() {
        if (!this._index) {
            return '(not indexed)';
        }
        const { files, root } = this._index;
        const lines = [`Workspace: ${path.basename(root)}`, ''];
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
    /** Build a nested file tree with exported symbols and language stats. */
    buildAnnotatedTree() {
        if (!this._index) {
            return '(not indexed)';
        }
        const { files, root } = this._index;
        const lines = [`Workspace: ${path.basename(root)}`, ''];
        const tree = new Map();
        const node = (p) => {
            if (!tree.has(p)) {
                tree.set(p, { subdirs: new Set(), files: [] });
            }
            return tree.get(p);
        };
        node('');
        for (const f of files) {
            const parts = f.relPath.replace(/\\/g, '/').split('/');
            for (let d = 1; d < parts.length; d++) {
                const parent = parts.slice(0, d - 1).join('/');
                const child = parts.slice(0, d).join('/');
                node(parent).subdirs.add(parts[d - 1]);
                node(child);
            }
            node(parts.slice(0, -1).join('/')).files.push(f);
        }
        const MAX_FILES_PER_DIR = 30;
        const render = (dirPath, dirName, indent) => {
            const n = tree.get(dirPath);
            if (!n) {
                return;
            }
            const childIndent = dirName ? indent + '  ' : indent;
            if (dirName) {
                lines.push(`${indent}${dirName}/`);
            }
            for (const sub of [...n.subdirs].sort()) {
                render(dirPath ? `${dirPath}/${sub}` : sub, sub, childIndent);
            }
            const sorted = [...n.files].sort((a, b) => a.relPath.localeCompare(b.relPath));
            for (const f of sorted.slice(0, MAX_FILES_PER_DIR)) {
                const name = path.basename(f.relPath);
                const exps = this._fileExports.get(f.relPath.replace(/\\/g, '/')) ?? [];
                const expsStr = exps.length > 0 ? ` [${exps.slice(0, 5).join(', ')}]` : '';
                lines.push(`${childIndent}${name} (${f.lines}L)${expsStr}`);
            }
            if (sorted.length > MAX_FILES_PER_DIR) {
                lines.push(`${childIndent}... +${sorted.length - MAX_FILES_PER_DIR} more`);
            }
        };
        render('', '', '');
        const langCounts = new Map();
        for (const f of files) {
            const lang = f.language || f.ext.toUpperCase();
            langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
        }
        const statsStr = [...langCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([l, n]) => `${l}: ${n}`)
            .join(' | ');
        lines.push('');
        if (statsStr) {
            lines.push(statsStr);
        }
        lines.push(`Total: ${files.length} files`);
        return lines.join('\n');
    }
    /**
     * Build a compact selection graph for the LLM file-selector.
     * Each entry shows the file, its import/importedBy edges, and every
     * function/class with exact line ranges so the LLM can select a specific
     * chunk instead of a whole file.
     */
    buildSelectionGraph() {
        if (!this._index) {
            return '(not indexed)';
        }
        const { files } = this._index;
        const lines = [];
        // Sort by baseScore descending so the most central files appear first
        const sorted = [...files].sort((a, b) => b.baseScore - a.baseScore);
        for (const f of sorted) {
            const relPosix = f.relPath.replace(/\\/g, '/');
            lines.push(`${relPosix} [${f.language} | ${f.lines}L | score:${f.baseScore}]`);
            const deps = this._imports.get(relPosix) ?? [];
            const callers = this._importedBy.get(relPosix) ?? [];
            if (deps.length) {
                lines.push(`  imports: ${deps.join(', ')}`);
            }
            if (callers.length) {
                lines.push(`  used-by: ${callers.join(', ')}`);
            }
            const { functions, classes } = f.symbolMeta;
            for (const fn of functions) {
                lines.push(`  fn ${fn.name} [ln ${fn.lineStart}–${fn.lineEnd}]${fn.exported ? '' : ' (internal)'}`);
            }
            for (const cls of classes) {
                const methodStr = cls.methods.length ? ` methods: ${cls.methods.join(', ')}` : '';
                lines.push(`  class ${cls.name} [ln ${cls.lineStart}–${cls.lineEnd}]${cls.exported ? '' : ' (internal)'}${methodStr}`);
            }
            if (!functions.length && !classes.length) {
                lines.push(`  (types/interfaces only)`);
            }
            lines.push('');
        }
        lines.push(`Total: ${files.length} files`);
        return lines.join('\n');
    }
    /** Resolve a relative path to absolute. */
    resolveRelPath(relPath) {
        if (!this._index) {
            return null;
        }
        return path.join(this._index.root, relPath);
    }
    getRoot() {
        return this._index?.root ?? null;
    }
    /** Returns the top N most central files by baseScore — used for style context sampling */
    getTopFiles(n) {
        if (!this._index) {
            return [];
        }
        return [...this._index.files]
            .filter(f => !this.isFluxignored(f.relPath) && !f.large)
            .sort((a, b) => b.baseScore - a.baseScore)
            .slice(0, n)
            .map(f => ({ relPath: f.relPath, absPath: f.absPath }));
    }
}
exports.WorkspaceIndexer = WorkspaceIndexer;
//# sourceMappingURL=indexer.js.map