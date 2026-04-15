import * as fs from 'fs';
import * as path from 'path';

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.dart', '.py', '.go'];
const INDEX_NAMES = EXTENSIONS.map(e => `index${e}`);

function resolveToActualFile(absPath: string): string | null {
  if (fs.existsSync(absPath)) { return absPath; }
  for (const ext of EXTENSIONS) {
    const c = absPath + ext;
    if (fs.existsSync(c)) { return c; }
  }
  for (const idx of INDEX_NAMES) {
    const c = path.join(absPath, idx);
    if (fs.existsSync(c)) { return c; }
  }
  return null;
}

export function extractImports(content: string, absFilePath: string, wsRoot: string): string[] {
  const fileDir = path.dirname(absFilePath);
  const found = new Set<string>();
  const importRegex     = /(?:from|require\s*\(|import\s*\()\s*['"](\.[^'"]+)['"]/g;
  const reExportRegex   = /export\s+(?:\*|\{[^}]*\})\s+from\s*['"](\.[^'"]+)['"]/g;
  const sideEffectRegex = /^\s*import\s+['"](\.[^'"]+)['"]/gm;
  for (const regex of [importRegex, reExportRegex, sideEffectRegex]) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const rawImport = match[1];
      if (!rawImport?.startsWith('.')) { continue; }
      const absImport = path.resolve(fileDir, rawImport);
      const resolved = resolveToActualFile(absImport);
      if (resolved) {
        found.add(path.relative(wsRoot, resolved).replace(/\\/g, '/'));
      }
    }
  }
  return [...found];
}

// Matches declarations across JS/TS/Python/Go/Rust/Swift/Dart
const DECL_RE = /^(?:(export|pub)\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|type|interface|enum|def|fn|func|struct|trait)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

export function extractSymbols(content: string): { exports: string[]; symbols: string[] } {
  const exports: string[] = [];
  const allSymbols: string[] = [];
  for (const line of content.split('\n').slice(0, 300)) {
    const trimmed = line.trim();
    const match = trimmed.match(DECL_RE);
    if (!match) { continue; }
    const isExported = !!match[1];
    const name = match[2];
    allSymbols.push(name);
    if (isExported) { exports.push(name); }
  }
  return {
    exports: [...new Set(exports)].slice(0, 30),
    symbols: [...new Set(allSymbols)].slice(0, 30),
  };
}
