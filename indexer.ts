import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { FileEntry, WorkspaceIndex } from './types';

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

export class WorkspaceIndexer {
  private _index: WorkspaceIndex | null = null;
  private _gitignorePatterns: RegExp[] = [];
  private _fluxignorePatterns: RegExp[] = [];
  private _storageUri: vscode.Uri | undefined;

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
      const data = JSON.parse(Buffer.from(bytes).toString('utf8')) as WorkspaceIndex;
      // Only use cache if it matches the current workspace root
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders[0].uri.fsPath !== data.root) { return false; }
      this._index = data;
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
      await vscode.workspace.fs.writeFile(cacheFile, Buffer.from(JSON.stringify(this._index), 'utf8'));
      this._outputChannel.appendLine(`[Indexer] Cache saved (${this._index.files.length} files)`);
    } catch (e) {
      this._outputChannel.appendLine(`[Indexer] Cache save failed: ${e}`);
    }
  }

  get index(): WorkspaceIndex | null {
    return this._index;
  }

  async build(
    onProgress: (done: number, total: number) => void
  ): Promise<WorkspaceIndex> {
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
    const allPaths: string[] = [];
    this._walkDir(root, root, allPaths);

    this._outputChannel.appendLine(`[Indexer] Found ${allPaths.length} files`);

    const files: FileEntry[] = [];
    let done = 0;

    for (const absPath of allPaths.slice(0, MAX_FILES)) {
      try {
        const entry = this._processFile(absPath, root);
        if (entry) {
          files.push(entry);
        }
      } catch {
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
    this._outputChannel.appendLine(`[Indexer] Indexed ${files.length} files`);
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

  private _processFile(absPath: string, root: string): FileEntry | null {
    const stat = fs.statSync(absPath);
    if (stat.size > MAX_FILE_SIZE) { return null; }

    const relPath = path.relative(root, absPath);
    const ext = path.extname(absPath).replace('.', '').toLowerCase();

    let content: string;
    try {
      content = fs.readFileSync(absPath, 'utf8');
    } catch {
      return null;
    }

    const lines = content.split('\n').length;
    const symbols = this._extractSymbols(content, ext);

    return { absPath, relPath, ext, lines, symbols, size: stat.size };
  }

  private _extractSymbols(content: string, ext: string): string[] {
    const symbols: string[] = [];
    const lines = content.split('\n').slice(0, 200); // Only scan first 200 lines

    for (const line of lines) {
      const trimmed = line.trim();

      // TypeScript / JavaScript
      if (['ts', 'tsx', 'js', 'jsx', 'mjs'].includes(ext)) {
        let m: RegExpMatchArray | null;
        // export function / export async function / function
        m = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
        if (m) { symbols.push(m[1]); continue; }
        // export const foo = / export class Foo
        m = trimmed.match(/^export\s+(?:const|let|var|class|type|interface|enum)\s+(\w+)/);
        if (m) { symbols.push(m[1]); continue; }
        // class Foo
        m = trimmed.match(/^(?:abstract\s+)?class\s+(\w+)/);
        if (m) { symbols.push(m[1]); continue; }
        // const foo = () =>
        m = trimmed.match(/^(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/);
        if (m) { symbols.push(m[1]); continue; }
      }

      // Python
      if (ext === 'py') {
        let m: RegExpMatchArray | null;
        m = trimmed.match(/^(?:async\s+)?def\s+(\w+)/);
        if (m) { symbols.push(m[1]); continue; }
        m = trimmed.match(/^class\s+(\w+)/);
        if (m) { symbols.push(m[1]); continue; }
      }

      // Go
      if (ext === 'go') {
        const m = trimmed.match(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/);
        if (m) { symbols.push(m[1]); continue; }
      }

      // Rust
      if (ext === 'rs') {
        let m: RegExpMatchArray | null;
        m = trimmed.match(/^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);
        if (m) { symbols.push(m[1]); continue; }
        m = trimmed.match(/^(?:pub\s+)?struct\s+(\w+)/);
        if (m) { symbols.push(m[1]); continue; }
      }
    }

    // Deduplicate and limit
    return [...new Set(symbols)].slice(0, 30);
  }

  private _loadIgnoreFile(root: string, filename: string): RegExp[] {
    const patterns: RegExp[] = [];
    const gitignorePath = path.join(root, filename);
    if (!fs.existsSync(gitignorePath)) { return patterns; }

    try {
      const lines = fs.readFileSync(gitignorePath, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) { continue; }
        try {
          // Convert glob pattern to regex (simplified)
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

  /** Returns true if the given relative path matches a .fluxignore pattern */
  isFluxignored(relPath: string, isDir = false): boolean {
    return this._isFluxignored(relPath, isDir);
  }

  /** Patch a single file entry in the index (called on file save) */
  patchFile(absPath: string): void {
    if (!this._index) { return; }
    const existing = this._index.files.findIndex((f) => f.absPath === absPath);
    try {
      const entry = this._processFile(absPath, this._index.root);
      if (!entry) { return; }
      if (existing >= 0) { this._index.files[existing] = entry; }
      else { this._index.files.push(entry); }
    } catch {
      if (existing >= 0) { this._index.files.splice(existing, 1); }
    }
  }

  /** Build a compact file tree string for Claude's context */
  buildTreeString(): string {
    if (!this._index) { return '(not indexed)'; }

    const { files, root } = this._index;
    const lines: string[] = [`Workspace: ${path.basename(root)}`, ''];

    // Group by top-level directory
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
      if (entries.length > 40) {
        lines.push(`  ... and ${entries.length - 40} more files`);
      }
      lines.push('');
    }

    lines.push(`Total: ${files.length} files`);
    return lines.join('\n');
  }

  /** Resolve a relative path to absolute */
  resolveRelPath(relPath: string): string | null {
    if (!this._index) { return null; }
    const abs = path.join(this._index.root, relPath);
    return abs;
  }

  getRoot(): string | null {
    return this._index?.root ?? null;
  }
}