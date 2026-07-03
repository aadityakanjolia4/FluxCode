/**
 * Standalone pipeline test — no extension build needed.
 * Usage:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   npx tsx test-pipeline.ts
 *
 * Or for Mistral/Gemini:
 *   export MISTRAL_API_KEY=...  and set MODEL + PROVIDER below
 */

import { runPipeline } from './pipeline';
import { FileSelection } from './types';
import * as fs from 'fs';
import * as path from 'path';

// ── Config ────────────────────────────────────────────────────────────────────
const API_KEY  = process.env.ANTHROPIC_API_KEY ?? '';
const MODEL    = process.env.MODEL ?? 'claude-haiku-4-5-20251001'; // cheapest for testing
const PROMPT   = process.env.PROMPT ?? 'How does the chat intent get classified?';

if (!API_KEY) {
  console.error('Set ANTHROPIC_API_KEY env var before running.');
  process.exit(1);
}

// ── Fake workspace ────────────────────────────────────────────────────────────
// Two real files from this repo described as a minimal graph so selectFilesForChat
// has something to reason about.
const FAKE_FILE_TREE = `
pipeline.ts  [ts, 6KB, centrality=0.9]
  imports: claudeClient.ts, types.ts
  exports: runPipeline, PipelineOptions, PipelineResult

claudeClient.ts  [ts, 48KB, centrality=1.0]
  exports: classifyIntent, classifyComplexity, selectFiles, selectFilesForChat,
           chatReply, createPlan, generateEdits, generateEditsParallel,
           reviewEdits, validateEdits

types.ts  [ts, 1KB, centrality=0.5]
  exports: FileSelection, Message
`.trim();

// Maps relPath → actual content from disk (falls back to a stub)
function readFile(relPath: string): string {
  const abs = path.join(__dirname, relPath);
  try { return fs.readFileSync(abs, 'utf8'); }
  catch { return `// (stub — ${relPath} not found on disk)`; }
}

// ── Run ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nPrompt : "${PROMPT}"`);
  console.log(`Model  : ${MODEL}`);
  console.log('─'.repeat(60));

  const result = await runPipeline(PROMPT, FAKE_FILE_TREE, [], {
    apiKey: API_KEY,
    model: MODEL,

    resolveFiles: async (selections: FileSelection[]) => {
      return selections.map(s => ({
        relPath: s.relPath,
        content: readFile(s.relPath),
      }));
    },

    onStage: (stage) => process.stdout.write(`\n${stage}`),
  });

  console.log('\n' + '─'.repeat(60));
  console.log(`Files selected : ${result.filesRead.length}`);
  result.filesRead.forEach(f => console.log(`  · ${f.relPath}`));
  console.log('\nReply:\n');
  console.log(result.reply);
}

main().catch(err => { console.error(err); process.exit(1); });
