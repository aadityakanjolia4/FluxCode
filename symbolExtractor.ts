import * as fs from 'fs';
import * as path from 'path';
import { FunctionInfo, ClassInfo, SymbolMetadata } from './types';

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

/**
 * Extracts named imports and resolves each to its source file.
 * Handles: single-line and multi-line `import { foo, bar as b } from './path'`
 * Also handles `import type { ... }`.
 * Returns one entry per symbol: { symbol, sourceRelPath }.
 */
export function extractNamedImports(
  content: string,
  absFilePath: string,
  wsRoot: string,
): { symbol: string; sourceRelPath: string }[] {
  const fileDir = path.dirname(absFilePath);
  const results: { symbol: string; sourceRelPath: string }[] = [];

  // [^}]+ spans newlines (multi-line imports), which is correct for JS/TS
  const re = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"](\.[^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const rawPath = m[2];
    const resolved = resolveToActualFile(path.resolve(fileDir, rawPath));
    if (!resolved) { continue; }
    const sourceRelPath = path.relative(wsRoot, resolved).replace(/\\/g, '/');

    for (const item of m[1].split(',')) {
      // "foo as bar" → the ORIGINAL name (as defined in the source) is "foo"
      const sym = item.trim().split(/\s+as\s+/)[0].trim();
      if (sym && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(sym)) {
        results.push({ symbol: sym, sourceRelPath });
      }
    }
  }
  return results;
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

// ─── Language detection ───────────────────────────────────────────────────────

const EXT_LANGUAGE_MAP: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python',
  go: 'Go',
  rs: 'Rust',
  java: 'Java',
  kt: 'Kotlin',
  swift: 'Swift',
  cs: 'C#',
  c: 'C', cpp: 'C++', h: 'C/C++ Header', hpp: 'C++ Header',
  rb: 'Ruby',
  php: 'PHP',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
  md: 'Markdown', mdx: 'MDX',
  html: 'HTML', css: 'CSS', scss: 'SCSS', sass: 'Sass', less: 'Less',
  vue: 'Vue', svelte: 'Svelte', astro: 'Astro',
  sql: 'SQL', graphql: 'GraphQL', proto: 'Protobuf',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', fish: 'Fish',
  dockerfile: 'Dockerfile', makefile: 'Makefile',
  xml: 'XML', prisma: 'Prisma', env: 'Env',
};

export function detectLanguage(ext: string): string {
  return EXT_LANGUAGE_MAP[ext.toLowerCase()] ?? ext.toUpperCase();
}

// ─── Per-language symbol extractors ──────────────────────────────────────────

type SymbolResult = { exports: string[]; symbols: string[] };

const MAX_LINES = 400;
const MAX_SYMBOLS = 30;

function dedup(arr: string[]): string[] {
  return [...new Set(arr)].slice(0, MAX_SYMBOLS);
}

// TypeScript / JavaScript
const TS_EXPORT_RES = [
  // export [default] [async] function[*] Name
  /^export\s+(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  // export [default] [abstract] class Name
  /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  // export [declare] interface|type|enum Name
  /^export\s+(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  // export [declare] const|let|var Name
  /^export\s+(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
];

const TS_SYMBOL_RES = [
  /^(?:async\s+)?function\*?\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  /^(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  /^(?:interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  /^(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
];

function extractTsJsSymbols(content: string): SymbolResult {
  const exports: string[] = [];
  const symbols: string[] = [];

  for (const line of content.split('\n').slice(0, MAX_LINES)) {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) { continue; }

    let matched = false;
    for (const re of TS_EXPORT_RES) {
      const m = t.match(re);
      if (m?.[1]) {
        exports.push(m[1]);
        symbols.push(m[1]);
        matched = true;
        break;
      }
    }
    if (!matched) {
      for (const re of TS_SYMBOL_RES) {
        const m = t.match(re);
        if (m?.[1]) { symbols.push(m[1]); break; }
      }
    }
  }

  return { exports: dedup(exports), symbols: dedup(symbols) };
}

// Python — only top-level (non-indented) defs and classes
function extractPythonSymbols(content: string): SymbolResult {
  const exports: string[] = [];
  const symbols: string[] = [];

  for (const line of content.split('\n').slice(0, MAX_LINES)) {
    if (line.startsWith(' ') || line.startsWith('\t')) { continue; }
    const t = line.trim();

    const m = t.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/) ??
              t.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (!m?.[1]) { continue; }
    const name = m[1];
    symbols.push(name);
    if (!name.startsWith('_')) { exports.push(name); } // Python convention
  }

  return { exports: dedup(exports), symbols: dedup(symbols) };
}

// Go — exported names are capitalized
const GO_SYMBOL_RES = [
  /^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[(<[]/,  // func [recv] Name(
  /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+/,                          // type Name struct/interface
  /^(?:var|const)\s+([A-Za-z_][A-Za-z0-9_]*)\s/,                  // var/const Name
];

function extractGoSymbols(content: string): SymbolResult {
  const exports: string[] = [];
  const symbols: string[] = [];

  for (const line of content.split('\n').slice(0, MAX_LINES)) {
    const t = line.trim();
    if (!t || t.startsWith('//')) { continue; }
    for (const re of GO_SYMBOL_RES) {
      const m = t.match(re);
      if (m?.[1]) {
        const name = m[1];
        symbols.push(name);
        if (/^[A-Z]/.test(name)) { exports.push(name); } // exported = capitalized
        break;
      }
    }
  }

  return { exports: dedup(exports), symbols: dedup(symbols) };
}

// Rust — pub items are exported
const RUST_PATTERNS: { pub: boolean; re: RegExp }[] = [
  { pub: true,  re: /^pub(?:\([^)]*\))?\s+(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  { pub: true,  re: /^pub(?:\([^)]*\))?\s+(?:struct|enum|trait|type|mod)\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  { pub: true,  re: /^pub(?:\([^)]*\))?\s+const\s+([A-Z_][A-Z0-9_]*)/ },
  { pub: false, re: /^(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/ },
  { pub: false, re: /^(?:struct|enum|trait|type|impl|mod)\s+([A-Za-z_][A-Za-z0-9_]*)/ },
];

function extractRustSymbols(content: string): SymbolResult {
  const exports: string[] = [];
  const symbols: string[] = [];

  for (const line of content.split('\n').slice(0, MAX_LINES)) {
    const t = line.trim();
    if (!t || t.startsWith('//')) { continue; }
    for (const { pub, re } of RUST_PATTERNS) {
      const m = t.match(re);
      if (m?.[1]) {
        symbols.push(m[1]);
        if (pub) { exports.push(m[1]); }
        break;
      }
    }
  }

  return { exports: dedup(exports), symbols: dedup(symbols) };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function extractSymbols(content: string, ext = ''): { exports: string[]; symbols: string[] } {
  switch (ext.toLowerCase()) {
    case 'py':  return extractPythonSymbols(content);
    case 'go':  return extractGoSymbols(content);
    case 'rs':  return extractRustSymbols(content);
    default:    return extractTsJsSymbols(content);
  }
}

// ─── Rich symbol metadata (with line numbers) ─────────────────────────────────

const METHOD_SKIP = new Set([
  'if', 'else', 'for', 'while', 'switch', 'case', 'catch', 'try', 'finally',
  'return', 'throw', 'new', 'typeof', 'void', 'delete', 'super', 'yield', 'await',
  'import', 'export', 'class', 'function', 'const', 'let', 'var',
]);

/**
 * Scan forward from startIdx (0-based) to find the end of a brace-delimited block.
 * Returns a 1-based line number. String-literal braces are NOT excluded —
 * good enough for well-formed source files.
 */
function findBraceEnd(lines: string[], startIdx: number): number {
  let depth = 0, opened = false;
  for (let j = startIdx; j < Math.min(lines.length, startIdx + 800); j++) {
    for (const ch of lines[j]) {
      if (ch === '{') { depth++; opened = true; }
      else if (ch === '}' && opened && --depth === 0) { return j + 1; }
    }
  }
  return startIdx + 1; // fallback: single line
}

// ── TypeScript / JavaScript ──────────────────────────────────────────────────

function extractTsJsSymbolMeta(content: string): SymbolMetadata {
  const lines = content.split('\n');
  const functions: FunctionInfo[] = [];
  const classes: ClassInfo[] = [];
  let depth = 0; // brace depth tracked across ALL lines

  for (let i = 0; i < Math.min(lines.length, 2000); i++) {
    const t = lines[i].trim();

    if (depth === 0 && t && !t.startsWith('//') && !t.startsWith('*')) {
      // Class: export [default] [abstract|declare] class Name
      const cm = t.match(
        /^(?:(export)\s+)?(?:(?:default|abstract|declare)\s+)*class\s+([A-Za-z_$][A-Za-z0-9_$]*)/
      );
      if (cm && classes.length < 20) {
        const lineStart = i + 1;
        const lineEnd   = findBraceEnd(lines, i);
        const methods: string[] = [];
        // Scan class body: lines where brace depth before the line is 1
        let d = 0;
        for (let j = i; j < Math.min(lines.length, lineEnd); j++) {
          const before = d;
          for (const ch of lines[j]) {
            if (ch === '{') d++;
            else if (ch === '}') d--;
          }
          if (before === 1 && j > i) {
            const mt = lines[j].trim();
            const mm = mt.match(
              /^(?:(?:public|private|protected|static|async|override|abstract|readonly|declare|get|set)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*[(<]/
            );
            if (mm?.[1] && !METHOD_SKIP.has(mm[1]) && !methods.includes(mm[1])) {
              methods.push(mm[1]);
            }
          }
        }
        classes.push({ name: cm[2], lineStart, lineEnd, exported: !!cm[1], methods });
      }

      // Named function: [export] [default] [async] function[*] Name
      const fm = t.match(
        /^(?:(export)\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][A-Za-z0-9_$]*)/
      );
      if (!cm && fm && functions.length < 30) {
        functions.push({
          name: fm[2], lineStart: i + 1, lineEnd: findBraceEnd(lines, i), exported: !!fm[1],
        });
      }

      // const/let/var arrow or function expression (exported OR internal)
      // Pattern: [export] const Name = [async] (...) => or = [async] function
      if (!cm && !fm) {
        const am = t.match(
          /^(?:(export)\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)[^=]*=\s*(?:async\s+)?(?:\([^)]*\)\s*=>|[A-Za-z_$][A-Za-z0-9_$]*\s*=>|function[*\s(])/
        );
        if (am && functions.length < 30) {
          const lineEnd = t.includes('{') ? findBraceEnd(lines, i) : i + 1;
          functions.push({ name: am[2], lineStart: i + 1, lineEnd, exported: !!am[1] });
        }
      }
    }

    // Keep outer depth in sync so inner declarations are suppressed
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
  }

  return { functions, classes };
}

// ── Python ───────────────────────────────────────────────────────────────────

function extractPythonSymbolMeta(content: string): SymbolMetadata {
  const lines = content.split('\n');
  const functions: FunctionInfo[] = [];
  const classes: ClassInfo[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Only top-level (column 0, non-empty, non-comment)
    if (!line.trim() || line.startsWith(' ') || line.startsWith('\t') || line.trim().startsWith('#')) {
      i++; continue;
    }
    const t = line.trim();

    // Class
    const cm = t.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (cm && classes.length < 20) {
      const lineStart = i + 1;
      const methods: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (l.trim() && l[0] !== ' ' && l[0] !== '\t') { break; }
        const indent = l.match(/^(\s+)/)?.[1] ?? '';
        if ((indent === '    ' || indent === '\t') && l.trim()) {
          const mm = l.trim().match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/);
          if (mm?.[1] && !methods.includes(mm[1])) { methods.push(mm[1]); }
        }
        j++;
      }
      classes.push({ name: cm[1], lineStart, lineEnd: j, exported: !cm[1].startsWith('_'), methods });
      i = j; continue;
    }

    // Top-level function
    const fm = t.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (fm && functions.length < 30) {
      const lineStart = i + 1;
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (l.trim() && l[0] !== ' ' && l[0] !== '\t') { break; }
        j++;
      }
      functions.push({ name: fm[1], lineStart, lineEnd: j, exported: !fm[1].startsWith('_') });
      i = j; continue;
    }

    i++;
  }
  return { functions, classes };
}

// ── Go ───────────────────────────────────────────────────────────────────────

function extractGoSymbolMeta(content: string): SymbolMetadata {
  const lines = content.split('\n');
  const functions: FunctionInfo[] = [];
  const classes: ClassInfo[] = [];
  let depth = 0;

  for (let i = 0; i < Math.min(lines.length, 2000); i++) {
    const t = lines[i].trim();
    if (depth === 0 && t && !t.startsWith('//')) {
      // func [recv] Name( — includes methods on receivers
      const fm = t.match(/^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[(<[]/);
      if (fm && functions.length < 30) {
        functions.push({
          name: fm[1], lineStart: i + 1, lineEnd: findBraceEnd(lines, i),
          exported: /^[A-Z]/.test(fm[1]),
        });
      }
      // type Name struct|interface → class
      const tm = t.match(/^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)/);
      if (tm && classes.length < 20) {
        classes.push({
          name: tm[1], lineStart: i + 1, lineEnd: findBraceEnd(lines, i),
          exported: /^[A-Z]/.test(tm[1]), methods: [],
        });
      }
    }
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
  }
  return { functions, classes };
}

// ── Rust ─────────────────────────────────────────────────────────────────────

function extractRustSymbolMeta(content: string): SymbolMetadata {
  const lines = content.split('\n');
  const functions: FunctionInfo[] = [];
  const classes: ClassInfo[] = [];
  let depth = 0;

  for (let i = 0; i < Math.min(lines.length, 2000); i++) {
    const t = lines[i].trim();
    if (depth === 0 && t && !t.startsWith('//')) {
      const isPub = /^pub(?:\([^)]*\))?/.test(t);
      const fm = t.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (fm && functions.length < 30) {
        functions.push({ name: fm[1], lineStart: i + 1, lineEnd: findBraceEnd(lines, i), exported: isPub });
      }
      const sm = t.match(/^(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (!fm && sm && classes.length < 20) {
        classes.push({ name: sm[1], lineStart: i + 1, lineEnd: findBraceEnd(lines, i), exported: isPub, methods: [] });
      }
    }
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
  }
  return { functions, classes };
}

export function extractSymbolMeta(content: string, ext = ''): SymbolMetadata {
  switch (ext.toLowerCase()) {
    case 'py':  return extractPythonSymbolMeta(content);
    case 'go':  return extractGoSymbolMeta(content);
    case 'rs':  return extractRustSymbolMeta(content);
    case 'ts': case 'tsx': case 'js': case 'jsx':
    case 'mts': case 'cts': case 'mjs': case 'cjs':
      return extractTsJsSymbolMeta(content);
    default:    return { functions: [], classes: [] };
  }
}

// ─── Keywords ─────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  // Language keywords / built-ins
  'const', 'let', 'var', 'function', 'class', 'return', 'import', 'export',
  'from', 'type', 'interface', 'extends', 'implements', 'new', 'this',
  'true', 'false', 'null', 'undefined', 'async', 'await', 'for', 'while',
  'switch', 'case', 'break', 'continue', 'throw', 'catch', 'try', 'finally',
  'default', 'public', 'private', 'protected', 'static', 'readonly', 'abstract',
  'string', 'number', 'boolean', 'object', 'array', 'void', 'never', 'any',
  'def', 'self', 'pass', 'elif', 'none', 'super', 'yield', 'lambda', 'print',
  // Generic programming terms that carry no domain meaning
  'get', 'set', 'add', 'map', 'has', 'use', 'run', 'app', 'util',
  'data', 'list', 'item', 'name', 'path', 'file', 'node', 'root', 'key',
  'value', 'error', 'result', 'output', 'input', 'args', 'opts', 'options',
  'props', 'state', 'model', 'view', 'index', 'main', 'base', 'init', 'next',
  'create', 'update', 'delete', 'fetch', 'load', 'save', 'send', 'parse',
  'handle', 'event', 'param', 'config', 'setup', 'build', 'make',
  'push', 'pull', 'call', 'bind', 'find', 'sort', 'filter', 'reduce',
  'slice', 'join', 'split', 'trim', 'replace', 'match', 'then', 'each',
  // Generic module/file suffixes
  'test', 'spec', 'types', 'store', 'context', 'hook', 'middleware',
  'helper', 'utils', 'module', 'component', 'service', 'controller',
]);

function splitIdentifier(s: string): string[] {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .split(/[_\-./\s]+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length >= 3 && !/^\d+$/.test(w));
}

export function extractKeywords(content: string, relPath: string): string[] {
  const freq = new Map<string, number>();
  const bump = (w: string, pts: number) => {
    const lw = w.toLowerCase();
    if (lw.length < 3 || STOP_WORDS.has(lw) || /^\d/.test(lw)) { return; }
    freq.set(lw, (freq.get(lw) ?? 0) + pts);
  };

  // Highest weight: path segments (e.g. payment.ts → "payment")
  const stem = relPath.replace(/\.[^.]+$/, '');
  for (const seg of stem.split(/[/\\]/)) {
    for (const w of splitIdentifier(seg)) { bump(w, 8); }
  }

  // High weight: external package names (import/require)
  const pkgRe = /(?:from|require\s*\()\s*['"]([^'"./][^'"]*)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = pkgRe.exec(content)) !== null) {
    const pkg = m[1].split('/').find(p => !p.startsWith('@')) ?? m[1].split('/')[0];
    for (const w of splitIdentifier(pkg)) { bump(w, 5); }
  }

  // Med weight: all identifiers in file
  const identRe = /\b([A-Za-z_][A-Za-z0-9_]{2,})\b/g;
  while ((m = identRe.exec(content)) !== null) {
    for (const w of splitIdentifier(m[1])) { bump(w, 1); }
  }

  return [...freq.entries()]
    .filter(([, pts]) => pts >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([w]) => w);
}
