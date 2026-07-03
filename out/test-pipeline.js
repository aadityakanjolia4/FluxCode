"use strict";
/**
 * Standalone pipeline test — no extension build needed.
 * Usage:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   npx tsx test-pipeline.ts
 *
 * Or for Mistral/Gemini:
 *   export MISTRAL_API_KEY=...  and set MODEL + PROVIDER below
 */
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
const pipeline_1 = require("./pipeline");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// ── Config ────────────────────────────────────────────────────────────────────
const API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const MODEL = process.env.MODEL ?? 'claude-haiku-4-5-20251001'; // cheapest for testing
const PROMPT = process.env.PROMPT ?? 'How does the chat intent get classified?';
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
function readFile(relPath) {
    const abs = path.join(__dirname, relPath);
    try {
        return fs.readFileSync(abs, 'utf8');
    }
    catch {
        return `// (stub — ${relPath} not found on disk)`;
    }
}
// ── Run ───────────────────────────────────────────────────────────────────────
async function main() {
    console.log(`\nPrompt : "${PROMPT}"`);
    console.log(`Model  : ${MODEL}`);
    console.log('─'.repeat(60));
    const result = await (0, pipeline_1.runPipeline)(PROMPT, FAKE_FILE_TREE, [], {
        apiKey: API_KEY,
        model: MODEL,
        resolveFiles: async (selections) => {
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
//# sourceMappingURL=test-pipeline.js.map