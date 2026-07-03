import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FileEntry, WorkspaceIndex } from './types';
import { extractImports, extractNamedImports, extractSymbols, detectLanguage, extractSymbolMeta, extractKeywords, splitIdentifier } from './symbolExtractor';

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

export interface TraversalResult {
  relPath: string;
  depth: number;
  score: number;
  /** The file that introduced this one into the traversal */
  via: string;
  edgeType: 'import' | 'importedBy' | 'namedImport';
}

export class WorkspaceIndexer {
  private _index: WorkspaceIndex | null = null;
  private _gitignorePatterns: RegExp[] = [];
  private _fluxignorePatterns: RegExp[] = [];
  private _storageUri: vscode.Uri | undefined;
  private _imports        = new Map<string, string[]>();                    // relPath → direct deps
  private _importedBy     = new Map<string, string[]>();                    // relPath → dependents
  private _symbolToFiles  = new Map<string, string[]>();                    // symbol → files that export it
  private _fileExports    = new Map<string, string[]>();                    // relPath → exported symbol names
  private _transitiveDeps = new Map<string, string[]>();                    // relPath → all reachable deps (full closure)
  private _namedImports   = new Map<string, Record<string, string>>();      // relPath → { symbolName → sourceRelPath }
  private _keywordToFiles = new Map<string, string[]>();                    // keyword → files containing it
  private _idf            = new Map<string, number>();                       // keyword → idf score (recomputed after each full build/patch)
  private _symbolImporters = new Map<string, string[]>();                   // "sym@srcRelPath" → files that import sym from srcRelPath

  constructor(
    private readonly _outputChannel: vscode.OutputChannel,
    storageUri?: vscode.Uri
  ) {
    this._storageUri = storageUri;
  }

  /** Load persisted index from workspace storage. Returns true if loaded. */
  async tryLoad(): Promise<boolean> {
    if (!this._storageUri) { return false; }
    const cacheFile = vscode.Uri.joinPath(this._storageUri, 'index.json');
    try {
      const bytes = await vscode.workspace.fs.readFile(cacheFile);
      const data = JSON.parse(Buffer.from(bytes).toString('utf8')) as WorkspaceIndex & {
        graphImports?: Record<string, string[]>;
        graphImportedBy?: Record<string, string[]>;
        graphFileExports?: Record<string, string[]>;
        graphSymbolToFiles?: Record<string, string[]>;
        graphNamedImports?: Record<string, Record<string, string>>;
      };
      // Only use cache if it matches the current workspace root
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders[0].uri.fsPath !== data.root) { return false; }
      // Backfill fields added after initial cache version
      for (const f of data.files) {
        if (!f.language)               { f.language    = detectLanguage(f.ext); }
        if (!f.modifiedAt)             { f.modifiedAt  = 0; }
        if (!f.symbolMeta)             { f.symbolMeta  = { functions: [], classes: [] }; }
        // Migrate old string[] keywords to Record<string, number>
        if (!f.keywords)               { f.keywords    = {}; }
        else if (Array.isArray(f.keywords)) { f.keywords = Object.fromEntries((f.keywords as unknown as string[]).map(k => [k, 1])); }
        if (!f.keywordLines)           { f.keywordLines = {}; }
        if (f.large     === undefined) { f.large       = false; }
        if (f.baseScore === undefined) { f.baseScore   = 0; }
      }
      this._index = { root: data.root, files: data.files, builtAt: data.builtAt };

      // Restore maps from cache fields (with empty fallback for old caches)
      this._imports.clear();
      for (const [k, v] of Object.entries(data.graphImports ?? {})) { this._imports.set(k, v); }

      this._importedBy.clear();
      for (const [k, v] of Object.entries(data.graphImportedBy ?? {})) { this._importedBy.set(k, v); }

      this._fileExports.clear();
      for (const [k, v] of Object.entries(data.graphFileExports ?? {})) { this._fileExports.set(k, v); }

      this._symbolToFiles.clear();
      for (const [k, v] of Object.entries(data.graphSymbolToFiles ?? {})) { this._symbolToFiles.set(k, v); }

      this._namedImports.clear();
      for (const [k, v] of Object.entries(data.graphNamedImports ?? {})) {
        this._namedImports.set(k, v as Record<string, string>);
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
        for (const kw of Object.keys(file.keywords ?? {})) {
          const arr = this._keywordToFiles.get(kw) ?? [];
          arr.push(rel);
          this._keywordToFiles.set(kw, arr);
        }
      }
      this._rebuildIdf();
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
    } catch {
      return false;
    }
  }

  async saveCache(): Promise<void> {
    if (!this._storageUri || !this._index) { return; }
    try {
      await vscode.workspace.fs.createDirectory(this._storageUri);
      const cacheFile = vscode.Uri.joinPath(this._storageUri, 'index.json');
      const payload = {
        ...this._index,
        graphImports:       Object.fromEntries(this._imports),
        graphImportedBy:    Object.fromEntries(this._importedBy),
        graphFileExports:   Object.fromEntries(this._fileExports),
        graphSymbolToFiles: Object.fromEntries(this._symbolToFiles),
        graphNamedImports:  Object.fromEntries(this._namedImports),
      };
      await vscode.workspace.fs.writeFile(cacheFile, Buffer.from(JSON.stringify(payload), 'utf8'));
      this._outputChannel.appendLine(`[Indexer] Cache saved (${this._index.files.length} files)`);
    } catch (e) {
      this._outputChannel.appendLine(`[Indexer] Cache save failed: ${e}`);
    }
  }

  get index(): WorkspaceIndex | null {
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
  async build(
    onProgress: (done: number, total: number) => void,
    incremental = false
  ): Promise<WorkspaceIndex> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error('No workspace folder open');
    }

    const root = folders[0].uri.fsPath;
    this._outputChannel.appendLine(`[Indexer] Scanning: ${root}`);

    this._gitignorePatterns  = this._loadIgnoreFile(root, '.gitignore');
    this._fluxignorePatterns = this._loadIgnoreFile(root, '.fluxignore');

    const allPaths: string[] = [];
    this._walkDir(root, root, allPaths);
    this._outputChannel.appendLine(`[Indexer] Found ${allPaths.length} files`);

    // ── Incremental setup ────────────────────────────────────────────────────
    const useIncremental = incremental && this._index !== null;
    const prevEntries = new Map<string, FileEntry>(
      useIncremental ? this._index!.files.map(f => [f.absPath, f]) : []
    );

    if (!useIncremental) {
      this._imports.clear();
      this._importedBy.clear();
      this._symbolToFiles.clear();
      this._fileExports.clear();
      this._namedImports.clear();
      this._keywordToFiles.clear();
      this._symbolImporters.clear();
    }

    const files: FileEntry[] = [];
    const seenAbsPaths = new Set<string>();
    let done = 0;
    let reused = 0;
    let updated = 0;

    for (const absPath of allPaths.slice(0, MAX_FILES)) {
      seenAbsPaths.add(absPath);
      try {
        if (useIncremental) {
          const cached = prevEntries.get(absPath);
          if (cached) {
            let stat: fs.Stats;
            try { stat = fs.statSync(absPath); } catch {
              done++;
              if (done % 20 === 0) { onProgress(done, allPaths.length); await new Promise(r => setTimeout(r, 0)); }
              continue;
            }
            if (Math.abs(stat.mtimeMs - cached.modifiedAt) < 1) {
              // Unchanged — keep cached entry; maps already correct
              files.push(cached);
              reused++;
              done++;
              if (done % 20 === 0) { onProgress(done, allPaths.length); await new Promise(r => setTimeout(r, 0)); }
              continue;
            }
          }
        }
        const entry = this._processAndIndex(absPath, root);
        if (entry) { files.push(entry); updated++; }
      } catch {
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
    this._rebuildIdf();
    this._buildTransitiveClosure();

    this._outputChannel.appendLine(
      useIncremental
        ? `[Indexer] Re-indexed: ${updated} updated, ${reused} unchanged (${files.length} total)`
        : `[Indexer] Indexed ${files.length} files`
    );
    void this.saveCache();
    return this._index;
  }

  private _walkDir(dir: string, root: string, out: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const relPath = path.relative(root, absPath);

      if (entry.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(entry.name.toLowerCase())) { continue; }
        if (entry.name.startsWith('.') && entry.name !== '.github') { continue; }
        if (this._isGitignored(relPath, true)) { continue; }
        if (this._isFluxignored(relPath, true)) { continue; }
        this._walkDir(absPath, root, out);
      } else if (entry.isFile()) {
        if (ALWAYS_SKIP_FILES.has(entry.name)) { continue; }
        if (this._isGitignored(relPath, false)) { continue; }
        if (this._isFluxignored(relPath, false)) { continue; }
        const ext = path.extname(entry.name).replace('.', '').toLowerCase();
        const baseLower = entry.name.toLowerCase();
        if (!SUPPORTED_EXTS.has(ext) && !SUPPORTED_EXTS.has(baseLower)) { continue; }
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
  private _processAndIndex(absPath: string, root: string): FileEntry | null {
    let stat: fs.Stats;
    try { stat = fs.statSync(absPath); } catch { return null; }
    if (stat.size > 2 * MAX_FILE_SIZE) { return null; } // hard skip above 1 MB

    const relPath  = path.relative(root, absPath);
    const relPosix = relPath.replace(/\\/g, '/');
    const ext      = path.extname(absPath).replace('.', '').toLowerCase();
    const large    = stat.size > MAX_FILE_SIZE;

    let content: string;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch {
      return null;
    }

    // ── FileEntry fields ──────────────────────────────────────────────────
    const lines      = content.split('\n').length;
    const { symbols, exports: exportedSyms } = extractSymbols(content, ext);
    const language   = detectLanguage(ext);
    const modifiedAt = stat.mtimeMs;
    const symbolMeta = large ? { functions: [], classes: [] } : extractSymbolMeta(content, ext);
    const { keywords, keywordLines } = large ? { keywords: {}, keywordLines: {} } : extractKeywords(content, relPath);

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
    for (const kw of Object.keys(oldEntry?.keywords ?? {})) {
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
    const deps = extractImports(content, absPath, root);
    this._imports.set(relPosix, deps);
    for (const dep of deps) {
      const arr = this._importedBy.get(dep) ?? [];
      if (!arr.includes(relPosix)) { arr.push(relPosix); }
      this._importedBy.set(dep, arr);
    }

    const named = extractNamedImports(content, absPath, root);
    if (named.length > 0) {
      const namedEntry: Record<string, string> = {};
      for (const { symbol, sourceRelPath } of named) { namedEntry[symbol] = sourceRelPath; }
      this._namedImports.set(relPosix, namedEntry);
      for (const { symbol, sourceRelPath } of named) {
        const key = `${symbol}@${sourceRelPath}`;
        const arr = this._symbolImporters.get(key) ?? [];
        if (!arr.includes(relPosix)) { arr.push(relPosix); }
        this._symbolImporters.set(key, arr);
      }
    } else {
      this._namedImports.delete(relPosix);
    }

    this._fileExports.set(relPosix, exportedSyms);
    for (const sym of exportedSyms) {
      const arr = this._symbolToFiles.get(sym) ?? [];
      if (!arr.includes(relPosix)) { arr.push(relPosix); }
      this._symbolToFiles.set(sym, arr);
    }

    for (const kw of Object.keys(keywords)) {
      const arr = this._keywordToFiles.get(kw) ?? [];
      if (!arr.includes(relPosix)) { arr.push(relPosix); }
      this._keywordToFiles.set(kw, arr);
    }

    // baseScore filled by post-pass after all files are indexed
    return { absPath, relPath, ext, lines, symbols, size: stat.size, large, language, modifiedAt, symbolMeta, keywords, keywordLines, baseScore: 0 };
  }

  // ─── Map cleanup helper ────────────────────────────────────────────────────
  /**
   * Removes all map entries for a file. Used by deleteFile() and the incremental
   * build's stale-entry cleanup.
   */
  private _removeFromMaps(relPosix: string): void {
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
    for (const kw of Object.keys(entry?.keywords ?? {})) {
      const arr = this._keywordToFiles.get(kw) ?? [];
      this._keywordToFiles.set(kw, arr.filter(r => r !== relPosix));
    }

    this._transitiveDeps.delete(relPosix);
  }

  // ─── Public mutation API ──────────────────────────────────────────────────

  /** Patch a single file entry in the index (called on file save). */
  patchFile(absPath: string): void {
    if (!this._index) { return; }
    const root = this._index.root;
    const relPath = path.relative(root, absPath).replace(/\\/g, '/');
    const existing = this._index.files.findIndex((f) => f.absPath === absPath);

    try {
      const entry = this._processAndIndex(absPath, root);
      if (!entry) { return; }
      entry.baseScore = (this._fileExports.get(relPath) ?? []).length
                      + (this._imports.get(relPath) ?? []).length
                      + (this._importedBy.get(relPath) ?? []).length;
      if (existing >= 0) { this._index.files[existing] = entry; }
      else { this._index.files.push(entry); }
      this._rebuildTransitiveFor(relPath);
      this._rebuildIdf();
    } catch {
      if (existing >= 0) { this._index.files.splice(existing, 1); }
    }
  }

  /** Remove a deleted file from the index and all dependency maps. */
  deleteFile(absPath: string): void {
    if (!this._index) { return; }
    const root = this._index.root;
    const relPath = path.relative(root, absPath).replace(/\\/g, '/');
    const idx = this._index.files.findIndex(f => f.absPath === absPath);
    if (idx < 0) { return; }

    // Remove from maps BEFORE splicing (so _removeFromMaps can still find the entry)
    this._removeFromMaps(relPath);
    this._index.files.splice(idx, 1);
    this._rebuildTransitiveFor(relPath);
    this._rebuildIdf();
  }

  // ─── Query API ─────────────────────────────────────────────────────────────

  /** Files directly imported by the given file (one level). */
  getDependencies(relPath: string): string[] {
    return this._imports.get(relPath.replace(/\\/g, '/')) ?? [];
  }

  /** Files that directly import the given file. */
  getDependents(relPath: string): string[] {
    return this._importedBy.get(relPath.replace(/\\/g, '/')) ?? [];
  }

  /**
   * Returns dependency metadata for a file:
   *   imports:    module-dot-notation paths this file imports
   *   importedBy: module-dot-notation paths that import this file
   */
  getDependencyMetadata(relPath: string): { imports: string[]; importedBy: string[] } {
    const toModule = (p: string) => p.replace(/\.[^.]+$/, '').replace(/[/\\]/g, '.');
    const key = relPath.replace(/\\/g, '/');
    return {
      imports:    (this._imports.get(key)    ?? []).map(toModule),
      importedBy: (this._importedBy.get(key) ?? []).map(toModule),
    };
  }

  /** All files reachable from relPath through any chain of imports. */
  getTransitiveDeps(relPath: string): string[] {
    return this._transitiveDeps.get(relPath.replace(/\\/g, '/')) ?? [];
  }

  /**
   * DFS traversal of the import graph starting from startRelPath.
   *   direction 'deps'       — follows outgoing import edges (what this file uses)
   *   direction 'dependents' — follows incoming edges (what imports this file)
   * Returns visited files in DFS visit order (excluding the start file itself),
   * each paired with its depth so callers can weight by distance.
   */
  dfsTraversal(
    startRelPath: string,
    direction: 'deps' | 'dependents' = 'deps',
    maxDepth = 5
  ): { relPath: string; depth: number }[] {
    const start   = startRelPath.replace(/\\/g, '/');
    const visited = new Set<string>();
    const result: { relPath: string; depth: number }[] = [];

    const dfs = (relPath: string, depth: number) => {
      if (visited.has(relPath) || depth > maxDepth) { return; }
      visited.add(relPath);
      if (relPath !== start) { result.push({ relPath, depth }); }
      const neighbors = direction === 'deps'
        ? (this._imports.get(relPath)    ?? [])
        : (this._importedBy.get(relPath) ?? []);
      for (const neighbor of neighbors) { dfs(neighbor, depth + 1); }
    };

    dfs(start, 0);
    return result;
  }

  /** Two-pointer minimum line distance between two sorted position arrays. O(a+b). */
  private _minLineDistance(a: number[], b: number[]): number {
    let i = 0, j = 0, min = Infinity;
    while (i < a.length && j < b.length) {
      const d = Math.abs(a[i] - b[j]);
      if (d < min) { min = d; }
      if (a[i] <= b[j]) { i++; } else { j++; }
    }
    return min;
  }

  /** Recompute IDF for every keyword across the current index. O(keywords). */
  private _rebuildIdf(): void {
    this._idf.clear();
    const files = this._index?.files ?? [];
    const N = files.length;
    if (N === 0) { return; }
    for (const [kw, fileList] of this._keywordToFiles) {
      const df = fileList.length;
      this._idf.set(kw, Math.log((N + 1) / (df + 1)) + 1);
    }
  }

  /**
   * Two-phase scored expansion of the import graph.
   *
   * Phase 1 — base scoring: every indexed file is scored with TF-IDF + symbol
   *   match + hub boost.  LLM-selected entry paths receive a +10 bonus so they
   *   always land in the seed set.
   *
   * Phase 2 — seed selection: top-SEED_K files by base score become seeds.
   *
   * Phase 3 — score propagation: iterative BFS from seeds.  Each hop divides
   *   the parent's score by (depth+1) and weights by edge direction:
   *     importedBy  ×1.2  (consumers signal demand)
   *     namedImport ×0.9
   *     import      ×0.8
   *
   * Phase 4 — blend & rank: finalScore = base×0.7 + propagated×0.3.
   *   Entry paths are excluded (they are already being read); top-maxFiles
   *   survivors are returned.
   *
   * @param entryPaths   Files already selected by the LLM
   * @param queryTokens  Tokens extracted from the user prompt
   * @param opts.direction  'forward' | 'reverse' | 'both'
   * @param opts.maxDepth   Max propagation hops (default 3)
   * @param opts.maxFiles   Max files to return (default 8)
   */
  guidedTraversal(
    entryPaths: string[],
    queryTokens: string[],
    opts: { direction?: 'forward' | 'reverse' | 'both'; maxDepth?: number; maxFiles?: number } = {}
  ): TraversalResult[] {
    const { direction = 'forward', maxDepth = 3, maxFiles = 8 } = opts;
    const lowerTokens = queryTokens.map(t => t.toLowerCase()).filter(t => t.length >= 3);
    const entrySet  = new Set(entryPaths.map(p => p.replace(/\\/g, '/')));
    const tokenSet  = new Set(lowerTokens); // used for O(1) lookup in named-import matching

    // ── Phase 1: base TF-IDF score for every indexed file ───────────────────
    const baseScores = new Map<string, number>();
    for (const file of this._index?.files ?? []) {
      const key = file.relPath.replace(/\\/g, '/');
      let score = 0;

      // Symbol match: +5 per query token that matches an exported symbol
      for (const token of lowerTokens) {
        for (const variant of [token, token[0].toUpperCase() + token.slice(1)]) {
          if ((this._symbolToFiles.get(variant) ?? []).includes(key)) { score += 5; break; }
        }
      }

      // Named import match: +3 base per symbol hit, +2 multi-term bonus if >1 query token matches
      // e.g. "retry payment" vs retryPayment → hits=2 → +5 total
      for (const sym of Object.keys(this._namedImports.get(key) ?? {})) {
        const symParts = new Set(splitIdentifier(sym));
        const hits = lowerTokens.reduce((n, t) => n + (symParts.has(t) ? 1 : 0), 0);
        if (hits === 0) { continue; }
        score += 3 + (hits > 1 ? 2 : 0);
      }

      // TF-IDF keyword score
      const kwMap = file.keywords;
      const totalTf = Math.max(1, Object.values(kwMap).reduce((s, v) => s + v, 0));
      const lenNorm = 1 + totalTf / 50;
      for (const token of lowerTokens) {
        const tf = kwMap[token];
        if (tf !== undefined) { score += (tf * (this._idf.get(token) ?? 1)) / lenNorm; }
      }

      // Proximity scoring: boost files where query terms appear close together
      if (lowerTokens.length >= 2) {
        let proximityScore = 0;
        let closePairs = 0;
        for (let a = 0; a < lowerTokens.length - 1; a++) {
          const posA = file.keywordLines[lowerTokens[a]];
          if (!posA) { continue; }
          for (let b = a + 1; b < lowerTokens.length; b++) {
            const posB = file.keywordLines[lowerTokens[b]];
            if (!posB) { continue; }
            const d = this._minLineDistance(posA, posB);
            if      (d <= 3)  { proximityScore += 5; closePairs++; }
            else if (d <= 10) { proximityScore += 3; }
            else if (d <= 30) { proximityScore += 1; }
          }
        }
        if (closePairs > 1) { proximityScore += closePairs - 1; } // bonus for multiple tight pairs
        score += Math.min(proximityScore, 10);
      }

      // Hub boost
      if (file.baseScore) { score += Math.log1p(file.baseScore) * 0.5; }

      // LLM entries always make it into seeds
      if (entrySet.has(key)) { score += 10; }

      baseScores.set(key, score);
    }

    // ── Phase 2: top-K seeds ─────────────────────────────────────────────────
    const SEED_K = 20;
    const seeds = [...baseScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, SEED_K);

    // ── Phase 3: BFS propagation from seeds ──────────────────────────────────
    const propagated = new Map<string, number>();
    const viaMap     = new Map<string, string>();
    const edgeMap    = new Map<string, TraversalResult['edgeType']>();
    const depthMap   = new Map<string, number>();
    // visited is global across all seeds — prevents cycles and double-processing
    const visited    = new Set<string>(seeds.map(([k]) => k));

    type Item = { node: string; depth: number; parentScore: number; via: string };
    const queue: Item[] = seeds.map(([relPath, score]) => ({
      node: relPath, depth: 0, parentScore: score, via: relPath,
    }));

    while (queue.length > 0) {
      const { node, depth, parentScore, via } = queue.shift()!;
      if (depth >= maxDepth) { continue; }

      const nextDepth = depth + 1;
      type Edge = [string, number, TraversalResult['edgeType']];
      const edges: Edge[] = [];

      if (direction === 'forward' || direction === 'both') {
        for (const dep of this._imports.get(node) ?? []) {
          edges.push([dep, 0.8, 'import']);
        }
        for (const src of new Set(Object.values(this._namedImports.get(node) ?? {}))) {
          edges.push([src, 0.9, 'namedImport']);
        }
      }
      if (direction === 'reverse' || direction === 'both') {
        for (const caller of this._importedBy.get(node) ?? []) {
          edges.push([caller, 1.2, 'importedBy']);
        }
      }

      for (const [neighbor, weight, edgeType] of edges) {
        const contribution = parentScore * weight / (nextDepth + 1);
        propagated.set(neighbor, (propagated.get(neighbor) ?? 0) + contribution);
        // Track the first (and thus shallowest) path for logging
        if (!depthMap.has(neighbor)) {
          viaMap.set(neighbor, via);
          edgeMap.set(neighbor, edgeType);
          depthMap.set(neighbor, nextDepth);
        }
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push({ node: neighbor, depth: nextDepth, parentScore, via });
        }
      }
    }

    // ── Phase 4: blend base + propagated, rank, return ───────────────────────
    const candidates: TraversalResult[] = [];
    for (const [relPath, propScore] of propagated) {
      if (entrySet.has(relPath)) { continue; }
      const base = baseScores.get(relPath) ?? 0;
      candidates.push({
        relPath,
        depth:    depthMap.get(relPath) ?? 1,
        score:    base * 0.7 + propScore * 0.3,
        via:      viaMap.get(relPath) ?? '',
        edgeType: edgeMap.get(relPath) ?? 'import',
      });
    }

    return candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, maxFiles);
  }

  /** Global symbol index: every exported symbol → the files that define it. */
  getGlobalSymbolIndex(): Record<string, string[]> {
    return Object.fromEntries(this._symbolToFiles);
  }

  /** Named imports for a file: which symbol came from which source file. */
  getNamedImports(relPath: string): Record<string, string> {
    return this._namedImports.get(relPath.replace(/\\/g, '/')) ?? {};
  }

  /** Files that export (or define) the given symbol name. */
  getFilesExportingSymbol(symbol: string): string[] {
    return this._symbolToFiles.get(symbol) ?? [];
  }

  /** Fast-path symbol → files lookup (alias for getFilesExportingSymbol). */
  getFilesBySymbol(name: string): string[] {
    return this._symbolToFiles.get(name) ?? [];
  }

  /**
   * Files that import the given symbol, optionally restricted to a specific source file.
   * e.g. getImportersOfSymbol("processPayment", "services/payment.ts")
   *      → files that do `import { processPayment } from './services/payment'`
   */
  getImportersOfSymbol(symbol: string, fromRelPath?: string): string[] {
    if (fromRelPath) {
      return this._symbolImporters.get(`${symbol}@${fromRelPath.replace(/\\/g, '/')}`) ?? [];
    }
    // Without a source filter: union across all source files for this symbol
    const result: string[] = [];
    const prefix = `${symbol}@`;
    for (const [key, files] of this._symbolImporters) {
      if (key.startsWith(prefix)) {
        for (const f of files) {
          if (!result.includes(f)) { result.push(f); }
        }
      }
    }
    return result;
  }

  /** Files whose keyword list contains the exact term. */
  getFilesByKeyword(term: string): string[] {
    return this._keywordToFiles.get(term) ?? [];
  }

  /**
   * Files that match any of the given terms.
   * Returned sorted by number of matching terms (descending).
   */
  searchFiles(terms: string[]): string[] {
    const hits = new Map<string, number>();
    for (const term of terms) {
      for (const rel of this._keywordToFiles.get(term) ?? []) {
        hits.set(rel, (hits.get(rel) ?? 0) + 1);
      }
    }
    return [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([rel]) => rel);
  }

  /** The exported symbols for a given relative path. */
  getExportsForFile(relPath: string): string[] {
    return this._fileExports.get(relPath.replace(/\\/g, '/')) ?? [];
  }

  /**
   * Returns the source lines for a named symbol plus optional surrounding context.
   * Looks up the symbol in the global index, finds its line range from symbolMeta,
   * then reads the file. Returns null if the symbol or its range is unknown.
   */
  getFunctionContext(
    symbolName: string,
    contextLines = 10,
  ): { relPath: string; lineStart: number; lineEnd: number; content: string } | null {
    if (!this._index) { return null; }

    const candidates = this._symbolToFiles.get(symbolName) ?? [];
    if (candidates.length === 0) { return null; }
    const relPath = candidates[0];

    const entry = this._index.files.find(f => f.relPath.replace(/\\/g, '/') === relPath);
    if (!entry) { return null; }

    const sym =
      entry.symbolMeta.functions.find(f => f.name === symbolName) ??
      entry.symbolMeta.classes.find(c => c.name === symbolName);
    if (!sym) { return null; }

    const absPath = path.join(this._index.root, relPath);
    let fileContent: string;
    try {
      fileContent = fs.readFileSync(absPath, 'utf8');
    } catch {
      return null;
    }

    const lines = fileContent.split('\n');
    const startIdx = Math.max(0, sym.lineStart - 1 - contextLines);
    const endIdx   = Math.min(lines.length, sym.lineEnd + contextLines);

    return {
      relPath,
      lineStart: startIdx + 1,
      lineEnd:   endIdx,
      content:   lines.slice(startIdx, endIdx).join('\n'),
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
  getRelatedFiles(relPath: string, limit = 20): string[] {
    if (!this._index) { return []; }
    const rel = relPath.replace(/\\/g, '/');
    const scored = new Map<string, number>();

    const add = (r: string, pts: number) => {
      if (r === rel) { return; }
      const entry = this._index!.files.find(f => f.relPath.replace(/\\/g, '/') === r);
      const boost = entry && entry.baseScore > 0 ? Math.log1p(entry.baseScore) : 0;
      scored.set(r, (scored.get(r) ?? 0) + pts + boost);
    };

    // Direct edges
    for (const dep of this._imports.get(rel) ?? [])    { add(dep, 5); }
    for (const dep of this._importedBy.get(rel) ?? []) { add(dep, 5); }

    const entry = this._index.files.find(f => f.relPath.replace(/\\/g, '/') === rel);
    if (entry) {
      // Shared keywords
      for (const kw of Object.keys(entry.keywords)) {
        for (const other of this._keywordToFiles.get(kw) ?? []) { add(other, 3); }
      }

      // Same directory
      const dir = rel.includes('/') ? rel.replace(/\/[^/]+$/, '') : '';
      for (const f of this._index.files) {
        const fRel = f.relPath.replace(/\\/g, '/');
        const fDir = fRel.includes('/') ? fRel.replace(/\/[^/]+$/, '') : '';
        if (fDir === dir && fRel !== rel) { add(fRel, 2); }
      }

      // Shared symbol name-prefix (first camelCase token, ≥3 chars)
      const myExports = this._fileExports.get(rel) ?? [];
      for (const sym of myExports) {
        const prefix = sym.replace(/([A-Z])/g, ' $1').trim().split(' ')[0].toLowerCase();
        if (prefix.length < 3) { continue; }
        for (const [sym2, files2] of this._symbolToFiles) {
          if (sym2 !== sym && sym2.toLowerCase().startsWith(prefix)) {
            for (const f of files2) { add(f, 1); }
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
  private _buildTransitiveClosure(): void {
    this._transitiveDeps.clear();

    const dfs = (node: string, stack: string[]): string[] => {
      if (this._transitiveDeps.has(node)) { return this._transitiveDeps.get(node)!; }
      const cycleIdx = stack.lastIndexOf(node);
      if (cycleIdx !== -1) { return stack.slice(cycleIdx); } // return actual cycle members

      stack.push(node);
      const all = new Set<string>();
      for (const direct of this._imports.get(node) ?? []) {
        all.add(direct);
        for (const t of dfs(direct, stack)) { all.add(t); }
      }
      stack.pop();

      const result = [...all];
      this._transitiveDeps.set(node, result);
      return result;
    };

    for (const node of this._imports.keys()) { dfs(node, []); }
  }

  /**
   * Incrementally updates the transitive closure after a single file is patched or deleted.
   * Only the affected file and its ancestors (files that transitively import it) are recomputed.
   */
  private _rebuildTransitiveFor(relPath: string): void {
    const affected = new Set<string>([relPath]);
    const queue = [relPath];
    while (queue.length > 0) {
      const node = queue.shift()!;
      for (const parent of this._importedBy.get(node) ?? []) {
        if (!affected.has(parent)) {
          affected.add(parent);
          queue.push(parent);
        }
      }
    }

    for (const node of affected) { this._transitiveDeps.delete(node); }

    const dfs = (node: string, stack: string[]): string[] => {
      if (this._transitiveDeps.has(node)) { return this._transitiveDeps.get(node)!; }
      const cycleIdx = stack.lastIndexOf(node);
      if (cycleIdx !== -1) { return stack.slice(cycleIdx); }
      stack.push(node);
      const all = new Set<string>();
      for (const direct of this._imports.get(node) ?? []) {
        all.add(direct);
        for (const t of dfs(direct, stack)) { all.add(t); }
      }
      stack.pop();
      const result = [...all];
      this._transitiveDeps.set(node, result);
      return result;
    };

    for (const node of affected) { dfs(node, []); }
  }

  // ─── Ignore helpers ────────────────────────────────────────────────────────

  private _loadIgnoreFile(root: string, filename: string): RegExp[] {
    const patterns: RegExp[] = [];
    const filePath = path.join(root, filename);
    if (!fs.existsSync(filePath)) { return patterns; }

    try {
      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) { continue; }
        try {
          const escaped = trimmed
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '[^/]');
          patterns.push(new RegExp(`(^|/)${escaped}($|/)`));
        } catch {
          // skip invalid pattern
        }
      }
    } catch {
      // ignore
    }

    return patterns;
  }

  private _isGitignored(relPath: string, isDir: boolean): boolean {
    const normalized = relPath.replace(/\\/g, '/');
    const checkPath = isDir ? normalized + '/' : normalized;
    return this._gitignorePatterns.some((p) => p.test(checkPath));
  }

  private _isFluxignored(relPath: string, isDir: boolean): boolean {
    const normalized = relPath.replace(/\\/g, '/');
    const checkPath = isDir ? normalized + '/' : normalized;
    return this._fluxignorePatterns.some((p) => p.test(checkPath));
  }

  /** Returns true if the given relative path matches a .fluxignore pattern. */
  isFluxignored(relPath: string, isDir = false): boolean {
    return this._isFluxignored(relPath, isDir);
  }

  // ─── Tree / display helpers ────────────────────────────────────────────────

  /** Build a compact file tree string for Claude's context. */
  buildTreeString(): string {
    if (!this._index) { return '(not indexed)'; }

    const { files, root } = this._index;
    const lines: string[] = [`Workspace: ${path.basename(root)}`, ''];

    const groups = new Map<string, FileEntry[]>();
    for (const f of files) {
      const parts = f.relPath.replace(/\\/g, '/').split('/');
      const topDir = parts.length > 1 ? parts[0] : '.';
      if (!groups.has(topDir)) { groups.set(topDir, []); }
      groups.get(topDir)!.push(f);
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
      if (entries.length > 40) { lines.push(`  ... and ${entries.length - 40} more files`); }
      lines.push('');
    }

    lines.push(`Total: ${files.length} files`);
    return lines.join('\n');
  }

  /** Build a nested file tree with exported symbols and language stats. */
  buildAnnotatedTree(): string {
    if (!this._index) { return '(not indexed)'; }

    const { files, root } = this._index;
    const lines: string[] = [`Workspace: ${path.basename(root)}`, ''];

    type DirNode = { subdirs: Set<string>; files: FileEntry[] };
    const tree = new Map<string, DirNode>();
    const node = (p: string): DirNode => {
      if (!tree.has(p)) { tree.set(p, { subdirs: new Set(), files: [] }); }
      return tree.get(p)!;
    };
    node('');

    for (const f of files) {
      const parts = f.relPath.replace(/\\/g, '/').split('/');
      for (let d = 1; d < parts.length; d++) {
        const parent = parts.slice(0, d - 1).join('/');
        const child  = parts.slice(0, d).join('/');
        node(parent).subdirs.add(parts[d - 1]);
        node(child);
      }
      node(parts.slice(0, -1).join('/')).files.push(f);
    }

    const MAX_FILES_PER_DIR = 30;
    const render = (dirPath: string, dirName: string, indent: string) => {
      const n = tree.get(dirPath);
      if (!n) { return; }
      const childIndent = dirName ? indent + '  ' : indent;

      if (dirName) { lines.push(`${indent}${dirName}/`); }

      for (const sub of [...n.subdirs].sort()) {
        render(dirPath ? `${dirPath}/${sub}` : sub, sub, childIndent);
      }

      const sorted = [...n.files].sort((a, b) => a.relPath.localeCompare(b.relPath));
      for (const f of sorted.slice(0, MAX_FILES_PER_DIR)) {
        const name    = path.basename(f.relPath);
        const exps    = this._fileExports.get(f.relPath.replace(/\\/g, '/')) ?? [];
        const expsStr = exps.length > 0 ? ` [${exps.slice(0, 5).join(', ')}]` : '';
        lines.push(`${childIndent}${name} (${f.lines}L)${expsStr}`);
      }
      if (sorted.length > MAX_FILES_PER_DIR) {
        lines.push(`${childIndent}... +${sorted.length - MAX_FILES_PER_DIR} more`);
      }
    };

    render('', '', '');

    const langCounts = new Map<string, number>();
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
    if (statsStr) { lines.push(statsStr); }
    lines.push(`Total: ${files.length} files`);
    return lines.join('\n');
  }

  /**
   * Build a compact selection graph for the LLM file-selector.
   * Each entry shows the file, its import/importedBy edges, and every
   * function/class with exact line ranges so the LLM can select a specific
   * chunk instead of a whole file.
   */
  buildSelectionGraph(): string {
    if (!this._index) { return '(not indexed)'; }

    const { files } = this._index;
    const lines: string[] = [];

    // Sort by baseScore descending so the most central files appear first
    const sorted = [...files].sort((a, b) => b.baseScore - a.baseScore);

    for (const f of sorted) {
      const relPosix = f.relPath.replace(/\\/g, '/');
      lines.push(`${relPosix} [${f.language} | ${f.lines}L | score:${f.baseScore}]`);

      const deps     = this._imports.get(relPosix)    ?? [];
      const callers  = this._importedBy.get(relPosix) ?? [];
      if (deps.length)    { lines.push(`  imports: ${deps.join(', ')}`); }
      if (callers.length) { lines.push(`  used-by: ${callers.join(', ')}`); }

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
  resolveRelPath(relPath: string): string | null {
    if (!this._index) { return null; }
    return path.join(this._index.root, relPath);
  }

  getRoot(): string | null {
    return this._index?.root ?? null;
  }

  /** Returns the top N most central files by baseScore — used for style context sampling */
  getTopFiles(n: number): { relPath: string; absPath: string }[] {
    if (!this._index) { return []; }
    return [...this._index.files]
      .filter(f => !this.isFluxignored(f.relPath) && !f.large)
      .sort((a, b) => b.baseScore - a.baseScore)
      .slice(0, n)
      .map(f => ({ relPath: f.relPath, absPath: f.absPath }));
  }
}



