/**
 * Full integration test harness — no VS Code extension needed.
 *
 * What it does:
 *   1. Mocks the vscode API (so indexer/agent code runs in plain Node)
 *   2. Builds a real WorkspaceIndexer on THIS repo
 *   3. Runs runPipeline with all graph callbacks wired up (expand, second-pass, resolve)
 *   4. Prints every stage, timing, files selected, guided-traversal scores, and the reply
 *
 * Prerequisites:
 *   npm install -D tsx
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *
 * Run:
 *   npx tsx test-harness.ts
 *
 * Debug (VS Code):
 *   Run > Start Debugging > "Debug: Test Harness"
 *   Set breakpoints in pipeline.ts, claudeClient.ts, indexer.ts — they all hit.
 *
 * Env vars:
 *   ANTHROPIC_API_KEY   required
 *   MODEL               default: claude-haiku-4-5-20251001  (cheapest)
 *   CHAT_PROMPT         override the default chat question
 *   CODE_PROMPT         set this to also run a code-intent test
 */

import * as path from 'path';
import * as fs from 'fs';

/* ─────────────────────────────────────────────────────────────────────────────
   STEP 0 — VS Code mock
   Must happen before any require() of vscode-dependent modules.
   We intercept Module._resolveFilename so 'vscode' → our cache entry.
───────────────────────────────────────────────────────────────────────────── */

// const WORKSPACE_ROOT = path.resolve(__dirname, '.');
const WORKSPACE_ROOT ="/Users/aadityakanjolia/Documents/meanwhyle/meanwhyle"
const outputLines: string[] = [];
const fakeChannel = {
  appendLine: (msg: string) => { outputLines.push(msg); process.stdout.write(`\x1b[2m  ${msg}\x1b[0m\n`); },
  append:     (msg: string) => outputLines.push(msg),
  show:   () => {},
  clear:  () => {},
  dispose:() => {},
};

const vscodeMock = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: WORKSPACE_ROOT } }],
    fs: {
      readFile:        async (uri: { fsPath: string }) =>
        Buffer.from(fs.readFileSync(uri.fsPath)),
      writeFile:       async (uri: { fsPath: string }, data: Buffer) =>
        fs.writeFileSync(uri.fsPath, data),
      createDirectory: async (uri: { fsPath: string }) =>
        fs.mkdirSync(uri.fsPath, { recursive: true }),
    },
    getConfiguration: (_section: string) => ({
      get: (_key: string, defaultVal?: unknown) => defaultVal,
    }),
    asRelativePath: (uri: { fsPath: string } | string) =>
      path.relative(WORKSPACE_ROOT, typeof uri === 'string' ? uri : uri.fsPath),
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => {
      const joined = path.join(base.fsPath, ...parts);
      return { fsPath: joined, toString: () => `file://${joined}` };
    },
  },
  languages:          { getDiagnostics: () => [] },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  window: {
    showErrorMessage:   (m: string) => console.error('[vscode.error]', m),
    showWarningMessage: (m: string) => console.warn('[vscode.warn]', m),
    createTerminal:     () => ({ sendText: () => {}, show: () => {} }),
  },
  WorkspaceEdit: class { insert() {}; replace() {} },
  Position:      class { constructor(public line: number, public character: number) {} },
  Range:         class { constructor(public start: unknown, public end: unknown) {} },
};

// Intercept module resolution so require('vscode') always hits our cache entry
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module');
const _origResolve = Module._resolveFilename.bind(Module);
Module._resolveFilename = (req: string, ...rest: unknown[]) =>
  req === 'vscode' ? 'vscode' : _origResolve(req, ...rest);

// Inject into require cache BEFORE any vscode-dependent module is loaded
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(require as any).cache['vscode'] = {
  id: 'vscode', filename: 'vscode', loaded: true,
  exports: vscodeMock, parent: module, children: [], paths: [],
};

/* ─────────────────────────────────────────────────────────────────────────────
   STEP 1 — Require vscode-dependent modules (safe now that mock is registered)
───────────────────────────────────────────────────────────────────────────── */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WorkspaceIndexer } = require('./indexer') as { WorkspaceIndexer: any };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runPipeline } = require('./pipeline') as {
  runPipeline: typeof import('./pipeline').runPipeline;
};

/* ─────────────────────────────────────────────────────────────────────────────
   Config
───────────────────────────────────────────────────────────────────────────── */

// Accepts ANTHROPIC_API_KEY, GEMINI_API_KEY, or MISTRAL_API_KEY — whichever is set.
// The right one is inferred from MODEL name. Pass it all under ANTHROPIC_API_KEY in
// launch.json (the harness doesn't care about the variable name, only the value).
const API_KEY = process.env.ANTHROPIC_API_KEY
  ?? process.env.GEMINI_API_KEY
  ?? process.env.MISTRAL_API_KEY
  ?? '';
const MODEL       = process.env.MODEL       ?? 'claude-haiku-4-5-20251001';
const CHAT_PROMPT = process.env.CHAT_PROMPT ?? 'How does the chat intent get classified?';
const CODE_PROMPT = process.env.CODE_PROMPT;          // undefined = skip code test

if (!API_KEY) {
  console.error('Set GEMINI_API_KEY, ANTHROPIC_API_KEY, or MISTRAL_API_KEY before running.');
  process.exit(1);
}

/* ─────────────────────────────────────────────────────────────────────────────
   Pretty-print helpers
───────────────────────────────────────────────────────────────────────────── */

const C = {
  reset: '\x1b[0m',  bold: '\x1b[1m',    dim: '\x1b[2m',
  cyan:  '\x1b[36m', green: '\x1b[32m',  yellow: '\x1b[33m',
  red:   '\x1b[31m', blue:  '\x1b[34m',  magenta: '\x1b[35m',
};

const banner  = (t: string) => console.log(`\n${C.bold}${C.cyan}${'═'.repeat(66)}\n  ${t}\n${'═'.repeat(66)}${C.reset}`);
const section = (t: string) => console.log(`\n${C.yellow}── ${t} ──${C.reset}`);
const ok      = (t: string) => console.log(`${C.green}  ✔ ${t}${C.reset}`);
const info    = (t: string) => console.log(`${C.blue}  ℹ ${t}${C.reset}`);
const warn    = (t: string) => console.log(`${C.red}  ✖ ${t}${C.reset}`);
const dim2    = (t: string) => console.log(`${C.dim}${t}${C.reset}`);

/* ─────────────────────────────────────────────────────────────────────────────
   Graph callbacks — mirrors agent.ts logic without any vscode dependency
───────────────────────────────────────────────────────────────────────────── */

function makeCallbacks(indexer: any) {
  const root: string = indexer.getRoot() ?? WORKSPACE_ROOT;

  const expandSelections = (
    selections: Array<{ relPath: string }>,
    prompt: string,
  ): Array<{ relPath: string }> => {
    const tokens = (prompt.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [])
      .filter((t: string) => t.length >= 3);

    const known = new Set(
      (indexer.index?.files ?? []).map((f: any) => f.relPath.replace(/\\/g, '/'))
    );

    const traversed: Array<{
      relPath: string; score: number; depth: number; via: string; edgeType: string;
    }> = indexer.guidedTraversal(
      selections.map(s => s.relPath), tokens,
      { direction: 'forward', maxDepth: 3, maxFiles: 8 },
    );

    section(`Guided traversal — ${traversed.length} candidate(s)`);
    for (const r of traversed) {
      dim2(`    ${r.relPath.padEnd(40)}  score:${r.score.toFixed(1).padStart(5)}  depth:${r.depth}  via:${r.via}  [${r.edgeType}]`);
    }

    const extra = traversed
      .filter(r => known.has(r.relPath))
      .map(r => ({ relPath: r.relPath }));

    return [...selections, ...extra];
  };

  const discoverSecondPass = (
    fileContents: Array<{ relPath: string; content: string }>,
    prompt: string,
  ): Array<{ relPath: string; lineStart?: number; lineEnd?: number }> => {
    const alreadyRead = new Set(fileContents.map(f => f.relPath.replace(/\\/g, '/')));
    const scores = new Map<string, number>();
    const ranges = new Map<string, { lineStart: number; lineEnd: number }>();
    const whole  = new Set<string>();

    const add = (relPath: string, pts: number, range?: { lineStart: number; lineEnd: number }) => {
      const key = relPath.replace(/\\/g, '/');
      if (alreadyRead.has(key)) { return; }
      const entry = indexer.index?.files.find((f: any) => f.relPath.replace(/\\/g, '/') === key);
      const hub   = entry?.baseScore > 0 ? Math.log1p(entry.baseScore) : 0;
      scores.set(key, (scores.get(key) ?? 0) + pts + hub);
      if (range && !whole.has(key) && !ranges.has(key)) { ranges.set(key, range); }
      else if (!range) { whole.add(key); ranges.delete(key); }
    };

    // Hybrid: BFS depth-2 broad sweep, then DFS from top-3 BFS hits
    const bfsVisited = new Set<string>(alreadyRead);
    const q: { relPath: string; depth: number }[] = fileContents.map(f => ({
      relPath: f.relPath, depth: 0,
    }));
    for (const f of fileContents) {
      for (const caller of indexer.getDependents(f.relPath)) { add(caller, 1); }
    }
    while (q.length > 0) {
      const { relPath, depth } = q.shift()!;
      if (bfsVisited.has(relPath) || depth >= 2) { continue; }
      bfsVisited.add(relPath);
      for (const dep of indexer.getDependencies(relPath)) {
        add(dep, Math.max(1, 3 - depth));
        q.push({ relPath: dep, depth: depth + 1 });
      }
    }
    const top3 = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => p);
    for (const start of top3) {
      for (const { relPath: dep, depth } of indexer.dfsTraversal(start, 'deps', 2)) {
        add(dep, Math.max(1, 3 - depth));
      }
    }

    // Symbol + keyword boost
    const words = new Set(
      (prompt.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []).filter((w: string) => w.length >= 3)
    );
    for (const word of words) {
      const ctx = indexer.getFunctionContext(word);
      if (ctx) { add(ctx.relPath, 5, { lineStart: ctx.lineStart, lineEnd: ctx.lineEnd }); }
      else { for (const rp of indexer.getFilesExportingSymbol(word)) { add(rp, 5); } }
      for (const rp of indexer.getImportersOfSymbol(word)) { add(rp, 3); }
    }
    for (const rp of indexer.searchFiles([...[...words].map((w: string) => w.toLowerCase())])) {
      add(rp, 2);
    }

    const results = [...scores.entries()]
      .filter(([, s]) => s >= 2.5)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([relPath]) => {
        const range = ranges.get(relPath);
        return range ? { relPath, ...range } : { relPath };
      });

    section(`Second-pass discovery — ${results.length} additional file(s)`);
    for (const r of results) {
      const range = 'lineStart' in r ? `  [${r.lineStart}–${r.lineEnd}]` : '';
      dim2(`    ${r.relPath}  score:${scores.get(r.relPath)!.toFixed(1)}${range}`);
    }

    return results;
  };

  const resolveFiles = async (
    selections: Array<{ relPath: string; lineStart?: number; lineEnd?: number }>,
  ): Promise<{ relPath: string; content: string }[]> => {
    const known = new Set((indexer.index?.files ?? []).map((f: any) => f.relPath));
    const out: { relPath: string; content: string }[] = [];

    for (const sel of selections) {
      if (!known.has(sel.relPath)) {
        info(`  [rejected — not in index] ${sel.relPath}`);
        continue;
      }
      const absPath = path.join(root, sel.relPath);
      try {
        const full = fs.readFileSync(absPath, 'utf8');
        const chunk = (sel.lineStart && sel.lineEnd)
          ? `// [lines ${sel.lineStart}–${sel.lineEnd}]\n` +
            full.split('\n').slice(sel.lineStart - 1, sel.lineEnd).join('\n')
          : full;
        out.push({ relPath: sel.relPath, content: chunk });
      } catch {
        warn(`  [unreadable] ${sel.relPath}`);
      }
    }
    return out;
  };

  return { expandSelections, discoverSecondPass, resolveFiles, root };
}

/* ─────────────────────────────────────────────────────────────────────────────
   Single test run
───────────────────────────────────────────────────────────────────────────── */

async function runTest(indexer: any, prompt: string) {
  banner(`PROMPT: "${prompt}"`);
  console.log(`${C.dim}  model: ${MODEL}${C.reset}`);

  const timing: Array<{ label: string; ms: number }> = [];
  let stageStart = Date.now();
  let lastLabel  = '';

  const cb     = makeCallbacks(indexer);
  const result = await runPipeline(prompt, indexer.buildSelectionGraph(), [], {
    apiKey: API_KEY,
    model:  MODEL,
    expandSelections:   cb.expandSelections,
    discoverSecondPass: cb.discoverSecondPass,
    resolveFiles:       cb.resolveFiles,

    onStage(stage) {
      const now = Date.now();
      if (lastLabel) { timing.push({ label: lastLabel, ms: now - stageStart }); }
      stageStart = now;
      lastLabel  = stage;
      process.stdout.write(`\n${stage} `);
    },
  });

  const now = Date.now();
  if (lastLabel) { timing.push({ label: lastLabel, ms: now - stageStart }); }
  console.log();

  // ── Stage timing ──────────────────────────────────────────────────────────
  section('Stage timing');
  const total = timing.reduce((s, t) => s + t.ms, 0);
  for (const { label, ms } of timing) {
    const bar = '█'.repeat(Math.round((ms / total) * 20));
    dim2(`  ${String(ms).padStart(5)}ms  ${bar}  ${label}`);
  }
  dim2(`  ${'─'.repeat(28)}`);
  dim2(`  ${String(total).padStart(5)}ms  total`);

  // ── Files read ────────────────────────────────────────────────────────────
  section(`Files read (${result.filesRead.length})`);
  if (result.filesRead.length === 0) {
    warn('No files were read — check that file selection is working');
  }
  for (const f of result.filesRead) {
    const range = f.lineStart ? `  [lines ${f.lineStart}–${f.lineEnd}]` : '';
    ok(`${f.relPath}${range}`);
  }

  // ── Edits (code intent only) ──────────────────────────────────────────────
  if (result.edits.length > 0) {
    section(`Proposed edits (${result.edits.length})`);
    for (const e of result.edits) {
      info(`${e.relPath ?? '(new file)'}  —  ${e.summary ?? ''}`);
    }
  }
  if (result.skipped.length > 0) {
    section(`Skipped edits (${result.skipped.length})`);
    for (const { edit, reason } of result.skipped) {
      warn(`${edit.relPath}  reason: ${reason}`);
    }
  }

  // ── Reply (chat intent) ───────────────────────────────────────────────────
  if (result.reply) {
    section('Reply');
    console.log(result.reply);
  }

  return result;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Entry point
───────────────────────────────────────────────────────────────────────────── */

async function main() {
  banner('Building workspace index');
  const indexer = new WorkspaceIndexer(fakeChannel); // no storageUri → skip cache read/write
  const t0 = Date.now();

  const index = await indexer.build((done: number, total: number) => {
    process.stdout.write(`\r  ${done}/${total} files indexed...`);
  });
  fs.writeFileSync('index-dump.json', JSON.stringify(index, null, 2));

  console.log();
  ok(`Index built in ${Date.now() - t0}ms  |  ${index.files.length} files`);

  // Top files by centrality
  section('Top 10 files by centrality (baseScore)');
  [...index.files]
    .sort((a: any, b: any) => b.baseScore - a.baseScore)
    .slice(0, 10)
    .forEach((f: any, i: number) =>
      dim2(`  ${String(i + 1).padStart(2)}.  score:${String(f.baseScore).padStart(3)}  ${f.relPath}`)
    );

  // Selection graph preview (what the LLM file-selector sees)
  section('Selection graph — first 30 lines (full graph goes to LLM)');
  dim2(indexer.buildSelectionGraph().split('\n').slice(0, 30).join('\n'));

  // Run tests
  // await runTest(indexer, CHAT_PROMPT);

  if (CODE_PROMPT) {
    await runTest(indexer, CODE_PROMPT);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
