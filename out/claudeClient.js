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
exports.classifyIntent = classifyIntent;
exports.validateEdits = validateEdits;
exports.validatePlanCoverage = validatePlanCoverage;
exports.chatReply = chatReply;
exports.selectFiles = selectFiles;
exports.createPlan = createPlan;
exports.generateEdits = generateEdits;
exports.generateEditsParallel = generateEditsParallel;
exports.reviewEdits = reviewEdits;
exports.runAgent = runAgent;
const https = __importStar(require("https"));
/* ============================================================
   INTENT CLASSIFIER
   Classifies a user prompt so the pipeline can skip code generation
   for questions, explanations, and accidental inputs.
============================================================ */
const CLASSIFY_SYSTEM = `You are an intent classifier for a VS Code AI coding assistant.

PRIMARY RULE: Base your decision almost entirely on the LAST user message. History is only a tiebreaker for very short/ambiguous messages (e.g. "fix it", "do it", "yes").

Classify as:
- "code"     — the last message wants to CREATE, EDIT, FIX, REFACTOR, DELETE, or otherwise CHANGE code or files
- "question" — the last message is ASKING something, wants an EXPLANATION, or seeks INFORMATION (no file changes)

If the last message clearly states its intent on its own, ignore history entirely.

Reply with ONLY the single word: code  OR  question`;
async function classifyIntent(apiKey, model, history, prompt) {
    if (!prompt.trim()) {
        return 'noop';
    }
    try {
        const messages = [
            // Last 4 messages of history give enough context for follow-ups
            ...history.slice(-4).map((m) => ({ role: m.role, content: m.content })),
            { role: 'user', content: prompt },
        ];
        const result = await request(apiKey, model, CLASSIFY_SYSTEM, messages, 5);
        return result.trim().toLowerCase().startsWith('question') ? 'question' : 'code';
    }
    catch {
        // On any API failure, default to code pipeline (planner handles non-code gracefully)
        return 'code';
    }
}
/* ============================================================
   RETRY — exponential backoff
============================================================ */
async function withRetry(fn, maxAttempts = 3, baseDelayMs = 800) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        }
        catch (e) {
            lastErr = e;
            if (attempt < maxAttempts) {
                await new Promise((r) => setTimeout(r, baseDelayMs * Math.pow(2, attempt - 1)));
            }
        }
    }
    throw lastErr;
}
/* ============================================================
   VALIDATION
============================================================ */
// validateEdits — pre-apply safety check.
// Skips edits that would fail:
//   • missing relPath
//   • path traversal attempts
//   • existing file incorrectly marked isNew:true
//   • empty newContent on new files
//   • empty oldString on snippet edits
//   • oldString not found in known file content
function validateEdits(edits, fileContents) {
    const contentMap = new Map(fileContents.map((f) => [f.relPath, f.content]));
    const valid = [];
    const skipped = [];
    for (const edit of edits) {
        if (!edit.relPath) {
            skipped.push({ edit, reason: 'Missing file path' });
            continue;
        }
        if (edit.relPath.includes('..') || edit.relPath.startsWith('/')) {
            skipped.push({ edit, reason: `Unsafe path: ${edit.relPath}` });
            continue;
        }
        if (edit.isNew) {
            // If the file was provided to us it already exists on disk — reject isNew:true
            if (contentMap.has(edit.relPath)) {
                skipped.push({ edit, reason: `"${edit.relPath}" was provided as an existing file but marked isNew:true — use oldString/newString instead` });
                continue;
            }
            if (!edit.newContent?.trim()) {
                skipped.push({ edit, reason: `New file "${edit.relPath}" has empty content` });
                continue;
            }
            valid.push(edit);
        }
        else {
            if (!edit.oldString) {
                skipped.push({ edit, reason: `Snippet edit for "${edit.relPath}" has no oldString` });
                continue;
            }
            // Only validate against known content — unread files pass through
            const content = contentMap.get(edit.relPath);
            if (content !== undefined && !content.includes(edit.oldString)) {
                const preview = edit.oldString.slice(0, 60).replace(/\n/g, '↵');
                skipped.push({ edit, reason: `oldString not found in "${edit.relPath}": "${preview}…"` });
                continue;
            }
            valid.push(edit);
        }
    }
    return { valid, skipped };
}
// validatePlanCoverage — returns a message for each plan step that has no matching edit.
// Callers should include these in retryContext.issues on the next attempt.
function validatePlanCoverage(plan, edits) {
    const editPaths = new Set(edits.map((e) => e.relPath));
    return plan.steps
        .filter((step) => !editPaths.has(step.relPath))
        .map((step) => `No edit for plan step [${step.action.toUpperCase()}] "${step.relPath}": ${step.description}`);
}
/* ============================================================
   HTTP
============================================================ */
async function request(apiKey, model, system, messages, maxTokens = 8192) {
    return withRetry(async () => {
        const body = JSON.stringify({ model, max_tokens: maxTokens, system, messages });
        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.anthropic.com',
                path: '/v1/messages',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'Content-Length': Buffer.byteLength(body),
                },
            };
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.error) {
                            reject(new Error(`API: ${parsed.error.message}`));
                            return;
                        }
                        resolve(parsed.content?.[0]?.text ?? '');
                    }
                    catch (e) {
                        reject(new Error(`Parse error: ${e}`));
                    }
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    });
}
async function requestWithTool(apiKey, model, system, messages, toolName, toolSchema, maxTokens = 32000) {
    return withRetry(async () => {
        const body = JSON.stringify({
            model, max_tokens: maxTokens, system, messages,
            tools: [{ name: toolName, description: 'Return the structured result', input_schema: toolSchema }],
            tool_choice: { type: 'tool', name: toolName },
        });
        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.anthropic.com',
                path: '/v1/messages',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'Content-Length': Buffer.byteLength(body),
                },
            };
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.error) {
                            reject(new Error(`API: ${parsed.error.message}`));
                            return;
                        }
                        if (parsed.stop_reason === 'max_tokens') {
                            reject(new Error('Response hit max_tokens. Try fewer/smaller files.'));
                            return;
                        }
                        const toolUse = (parsed.content ?? []).find((b) => b.type === 'tool_use');
                        if (toolUse?.input) {
                            resolve(toolUse.input);
                        }
                        else {
                            const fallback = parsed.content?.[0]?.text ?? '(empty)';
                            reject(new Error(`No tool_use block. Text: ${fallback.slice(0, 200)}`));
                        }
                    }
                    catch (e) {
                        reject(new Error(`Parse error: ${e}`));
                    }
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    });
}
function extractJson(text) {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    return JSON.parse(cleaned);
}
/* ============================================================
   CHAT REPLY — conversational responses (no code changes)
============================================================ */
const CHAT_SYSTEM = `You are a helpful AI coding assistant integrated into VS Code. When file contents are provided, read them carefully and base your answer on the actual code — reference specific functions, variables, and logic you see. Combine what you find in the code with your own knowledge to give a complete, accurate answer. Be concise but thorough — use markdown formatting (code blocks, bullet points) where it helps clarity.`;
async function chatReply(apiKey, model, history, userPrompt) {
    const messages = [
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: userPrompt },
    ];
    return request(apiKey, model, CHAT_SYSTEM, messages, 2048);
}
/* ============================================================
   AGENT 1: FILE SELECTOR
============================================================ */
const FILE_SELECTION_SYSTEM = `You are the file selector for an elite AI coding assistant. Given a workspace file tree and a user request, choose exactly the files needed so the assistant can deliver a complete, working implementation.

━━━ HOW TO CHOOSE FILES ━━━

1. IDENTIFY THE STACK
   Read the file tree and detect the language, framework, and architecture.
   Use every signal available: config files (package.json, pubspec.yaml, Cargo.toml, go.mod, requirements.txt, pom.xml, build.gradle, composer.json, Gemfile …), directory layout, file extensions, and naming patterns.
   Be specific — don't just say "Python project", say "Django 4 + DRF with a PostgreSQL backend".

2. IDENTIFY THE BACKBONE FILES FOR THAT STACK
   Every framework has files that are essential context for writing correct, wired-up code.
   Reason about which ones apply here:
   - The entry point / app bootstrap file (e.g. main.py, app.js, App.tsx, main.dart, Program.cs …)
   - The dependency manifest (package.json, requirements.txt, pubspec.yaml, etc.)
   - The routing / URL configuration (urls.py, router/index.ts, routes.rb, routes/ folder …)
   - The global configuration (settings.py, next.config.ts, application.yml, .env.example …)
   - The data layer (models.py, schema.prisma, entity files, migration files …)
   - Any shared types, interfaces, or base classes used across the codebase

3. ADD REQUEST-SPECIFIC FILES
   Include files the user's task directly touches or depends on.

4. ALWAYS INCLUDE REGISTRATION FILES
   If the task creates a new module, app, router, or feature, always include the file that
   registers or mounts it (urls.py, router/index.ts, app.js, main.py, routes.rb, etc.).
   Without it the planner cannot see the wiring convention and will miss it.

5. INCLUDE INIT / INDEX FILES FOR AFFECTED DIRECTORIES
   If the task creates files in a directory, include any existing init or index file for that
   directory if it appears in the tree (e.g. __init__.py, index.ts, index.js, mod.rs, barrel
   files). They are often required to register the new code.

━━━ OUTPUT ━━━
Respond ONLY with a JSON object (no markdown, no extra text):
{
  "thinking": "Stack: [specific framework + version if detectable]. Backbone files for this stack: [reason]. Request touches: [reason].",
  "filesToRead": ["exact/relative/path/file1", "exact/relative/path/file2"]
}

Rules:
- Maximum 10 files. Exact relative paths from the tree only.
- Always include the dependency manifest and key backbone files.
- Always include the routing/registration file — new features always need wiring.
- For new features, still read backbone files to understand wiring conventions.
- If the project is empty, return [] and describe the inferred stack in thinking.`;
async function selectFiles(apiKey, model, fileTree, history, userPrompt) {
    const messages = [
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: `Workspace file tree:\n\n${fileTree}\n\n---\nRequest: ${userPrompt}` },
    ];
    const text = await request(apiKey, model, FILE_SELECTION_SYSTEM, messages, 1024);
    try {
        const parsed = extractJson(text);
        return { filesToRead: parsed.filesToRead ?? [], thinking: parsed.thinking ?? '' };
    }
    catch {
        return { filesToRead: [], thinking: text };
    }
}
/* ============================================================
   AGENT 2: PLANNER
============================================================ */
const PLAN_SYSTEM = `You are a senior software architect. Analyze the codebase and produce a precise, step-by-step implementation plan for the given task.

Your plan goes to a separate coding agent. Be concrete — the coder must not need to make architectural decisions.

━━━ STEP 0 — CHECK IF CHANGES ARE NEEDED ━━━
Before planning, ask: does this task actually require code changes?
- If the feature is already fully implemented in the provided files → set steps to [] and explain in summary.
- If the request is not a coding task (a question, accidental input, or general comment) → set steps to [] and respond in summary.
Only proceed to plan when changes are genuinely required.

━━━ STEP 1 — STUDY THE CODEBASE PATTERNS ━━━
Before planning any changes, read the provided files carefully and identify:
- Naming conventions: camelCase vs snake_case, file naming, class/function naming patterns
- Code structure: how classes/modules are organized, how exports are done, file layout
- Patterns in use: design patterns, abstractions, utility helpers already present
- Error handling style: try/catch, Result types, error propagation approach
- Import style: relative vs absolute, named vs default exports, import ordering
- Code quality markers: comment style, type annotation density, test patterns
Document these observations in the thinking field. The coder MUST replicate these patterns — not invent new ones.

━━━ FOR EACH FILE THAT NEEDS TO CHANGE ━━━
- State CREATE (new file) or EDIT (existing file)
- Describe WHAT the change is — not the code, the intent
- Explicitly state which existing patterns/conventions the coder should follow for this file
- List all WIRING steps (register in config, add to router, add to navigator, etc.)
- Note dependencies between steps

━━━ COMPLETENESS RULES — NEVER SKIP THESE ━━━
1. SCAFFOLD FILES: When creating a file in a new directory, include a CREATE step for every
   required scaffold file in that directory (e.g. __init__.py for Python packages, mod.rs for
   Rust modules, barrel index files for TypeScript, etc.). Without these the directory is not
   a valid package and imports will fail.
2. DEPENDENCY MANIFEST: If a new external package/library is being imported that is not already
   in the dependency manifest, include an EDIT step for the manifest
   (requirements.txt, package.json, pubspec.yaml, Cargo.toml, go.mod, etc.).
3. REGISTRATION: Every new module, router, app, or controller must have an explicit EDIT step
   for the file that mounts or registers it (urls.py, router/index, main.py, app.js, etc.).
   Never leave a feature unregistered.
4. Do NOT skip wiring steps — a half-connected feature is worse than no feature.

Do NOT write actual code. Describe intent only.`;
const PLAN_TOOL_SCHEMA = {
    type: 'object',
    properties: {
        thinking: { type: 'string', description: 'Analysis: stack detected, patterns observed, what the task requires.' },
        summary: { type: 'string', description: 'Overall approach in 1–3 sentences.' },
        steps: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    relPath: { type: 'string' },
                    action: { type: 'string', enum: ['create', 'edit'] },
                    description: { type: 'string', description: 'Specific, concrete description of changes for this file.' },
                },
                required: ['relPath', 'action', 'description'],
            },
        },
    },
    required: ['thinking', 'summary', 'steps'],
};
async function createPlan(apiKey, model, history, userPrompt, fileContents) {
    const filesBlock = fileContents.length > 0
        ? fileContents.map((f) => `<file path="${f.relPath}">\n${f.content}\n</file>`).join('\n\n')
        : '(no existing files)';
    const messages = [
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: `Files:\n\n${filesBlock}\n\n---\nTask: ${userPrompt}\n\nCreate an implementation plan.` },
    ];
    const result = await requestWithTool(apiKey, model, PLAN_SYSTEM, messages, 'create_plan', PLAN_TOOL_SCHEMA, 4096);
    return {
        thinking: result.thinking ?? '',
        summary: result.summary ?? '',
        steps: (result.steps ?? []).map((s) => ({
            relPath: s.relPath ?? '',
            action: s.action === 'create' ? 'create' : 'edit',
            description: s.description ?? '',
        })),
    };
}
/* ============================================================
   AGENT 3: CODER
============================================================ */
const EDIT_SYSTEM = `You are a precise, deterministic code implementation agent. You receive a structured plan from a senior architect — implement it exactly using the apply_edits tool. Do not add anything not in the plan. Do not change code not mentioned in the plan.

━━━ BEFORE WRITING ANY CODE — STUDY THE PROVIDED FILES ━━━
Read every provided file carefully. Extract and internalize:
- Exact indentation (spaces vs tabs, how many)
- Quote style (single, double, backtick — be consistent per file)
- Naming: variables, functions, classes, files — match the exact convention used
- How similar features are already implemented — replicate that structure, do not invent a new approach
- How imports are organized and ordered
- Existing helper functions, utilities, base classes — USE them, do not duplicate
- Error handling patterns already in place — follow the same pattern
Your code must look like it was written by the same developer who wrote the existing code.

━━━ IMPLEMENTATION RULES ━━━
1. Follow EVERY step in the plan — do not skip any step, including scaffold and wiring steps.
2. Produce MINIMAL edits. Change only what the plan requires, nothing else.
3. Match the existing codebase exactly: indentation, quote style, naming conventions, code structure.
4. Reuse existing abstractions, helpers, and utilities already in the codebase — never reinvent them.
5. Complete all wiring (registration, routing, imports, exports) — never leave a feature half-connected.
6. Use correct types/interfaces for the language. No implicit any, no untyped dicts.
7. No TODO placeholders in logic paths. No hardcoded secrets.
8. If the plan has no steps (empty array), return edits: [] and explain in reply. Do NOT invent edits.

━━━ FILE EXISTENCE RULES ━━━
Files provided inside <file path="…"> blocks ARE ALREADY ON DISK.
• Always use isNew: false for any file that appears in the provided files block.
• Never mark an existing file as isNew: true — doing so overwrites it instead of patching it.
• Only use isNew: true for files that do NOT appear in the provided files block.
• If you need to edit a provided file but cannot find a unique oldString, widen the context
  window (include more surrounding lines) until it is unique.

━━━ EDIT FORMAT ━━━

EXISTING FILES — snippet replace only:
  • oldString: copy the exact characters from the file including all surrounding whitespace/indentation.
    Include 2–3 context lines above and below to make it unique in the file.
    If still not unique, include more context. NEVER truncate mid-token.
  • newString: the replacement. Must use the same indentation style as the file.
  • One edit per logical change. Multiple edits to the same file apply top-to-bottom.

NEW FILES — complete content:
  • isNew: true, newContent: the full file from top to bottom.
  • Only for files NOT present in the provided files block.

━━━ RETRY CONTEXT ━━━
If you receive reviewer feedback, fix EVERY listed issue. Do not resubmit with the same problems.`;
const EDIT_TOOL_SCHEMA = {
    type: 'object',
    properties: {
        thinking: { type: 'string', description: 'First: conventions observed in the existing files (naming, indentation, patterns, reusable helpers). Then: how each plan step maps to edits and which conventions are being followed.' },
        reply: { type: 'string', description: 'Concise user-facing summary: what changed and any required manual steps.' },
        edits: {
            type: 'array',
            description: 'Ordered edits — multiple edits to the same file apply top-to-bottom.',
            items: {
                type: 'object',
                properties: {
                    relPath: { type: 'string' },
                    isNew: { type: 'boolean', description: 'true = new file (use newContent). false = existing file (use oldString + newString).' },
                    summary: { type: 'string' },
                    oldString: { type: 'string', description: 'EXISTING FILES ONLY. Exact text to replace — include surrounding context lines.' },
                    newString: { type: 'string', description: 'EXISTING FILES ONLY. Replacement. Empty string to delete.' },
                    newContent: { type: 'string', description: 'NEW FILES ONLY. Complete file content.' },
                },
                required: ['relPath', 'isNew', 'summary'],
            },
        },
    },
    required: ['thinking', 'reply', 'edits'],
};
function formatPlanBlock(plan) {
    if (!plan.steps.length) {
        return '(no plan steps)';
    }
    const steps = plan.steps
        .map((s, i) => `  ${i + 1}. [${s.action.toUpperCase()}] ${s.relPath}\n     ${s.description}`)
        .join('\n');
    return `IMPLEMENTATION PLAN\nSummary: ${plan.summary}\n\nSteps:\n${steps}`;
}
function formatEditsBlock(edits) {
    return edits.map((e) => {
        if (e.isNew) {
            return `<new_file path="${e.relPath}">\n${e.newContent ?? ''}\n</new_file>`;
        }
        return `<snippet_edit path="${e.relPath}" summary="${e.summary}">\nOLD:\n${e.oldString ?? ''}\n\nNEW:\n${e.newString ?? ''}\n</snippet_edit>`;
    }).join('\n\n');
}
async function generateEdits(apiKey, model, history, userPrompt, fileContents, plan, retryContext) {
    const filesBlock = fileContents.length > 0
        ? fileContents.map((f) => `<file path="${f.relPath}">\n${f.content}\n</file>`).join('\n\n')
        : '(no existing files)';
    let userContent = `Files:\n\n${filesBlock}`;
    if (plan?.steps.length) {
        userContent += `\n\n---\n${formatPlanBlock(plan)}`;
    }
    userContent += `\n\n---\nTask: ${userPrompt}`;
    if (retryContext) {
        userContent += '\n\n━━━ REVIEWER REJECTED YOUR PREVIOUS EDITS — FIX ALL ISSUES BELOW ━━━';
        userContent += `\nFeedback: ${retryContext.reviewFeedback}`;
        if (retryContext.issues.length) {
            userContent += `\n\nIssues:\n${retryContext.issues.map((i) => `  • ${i}`).join('\n')}`;
        }
        userContent += `\n\nYour rejected edits:\n\n${formatEditsBlock(retryContext.previousEdits)}`;
    }
    const messages = [
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: userContent },
    ];
    const result = await requestWithTool(apiKey, model, EDIT_SYSTEM, messages, 'apply_edits', EDIT_TOOL_SCHEMA, 32000);
    const edits = (result.edits ?? []).map((e) => ({
        relPath: e.relPath ?? '',
        isNew: e.isNew ?? false,
        summary: e.summary ?? '',
        newContent: e.newContent,
        oldString: e.oldString,
        newString: e.newString,
    }));
    // Detect plan steps that have no corresponding edit and surface them in thinking
    // so callers can include them in retryContext.issues on the next attempt.
    const coverageGaps = plan?.steps.length ? validatePlanCoverage(plan, edits) : [];
    const thinking = coverageGaps.length
        ? `${result.thinking ?? ''}\n\n⚠ COVERAGE GAPS (plan steps with no edit):\n${coverageGaps.map((g) => `  • ${g}`).join('\n')}`
        : (result.thinking ?? '');
    return {
        filesToRead: fileContents.map((f) => f.relPath),
        edits,
        reply: result.reply ?? '(no reply)',
        thinking,
    };
}
/* ============================================================
   AGENT 3b: PARALLEL CODERS
   Runs two independent coder instances for the same task.
   The candidate with more valid edits wins. If one throws, the other is used.
============================================================ */
async function generateEditsParallel(apiKey, model, history, userPrompt, fileContents, plan) {
    const args = [apiKey, model, history, userPrompt, fileContents, plan];
    const [r1, r2] = await Promise.allSettled([
        generateEdits(...args),
        generateEdits(...args),
    ]);
    if (r1.status === 'fulfilled' && r2.status === 'rejected') {
        return r1.value;
    }
    if (r1.status === 'rejected' && r2.status === 'fulfilled') {
        return r2.value;
    }
    if (r1.status === 'rejected' && r2.status === 'rejected') {
        throw r1.reason;
    }
    const v1 = validateEdits(r1.value.edits, fileContents);
    const v2 = validateEdits(r2.value.edits, fileContents);
    return v1.valid.length >= v2.valid.length
        ? r1.value
        : r2.value;
}
/* ============================================================
   AGENT 4: REVIEWER
============================================================ */
const REVIEW_SYSTEM = `You are a strict senior code reviewer. You receive:
  1. The implementation plan (what was supposed to be built)
  2. The original file contents (files that already exist on disk)
  3. The proposed edits (snippet replacements or new file contents)

Verify the edits correctly and completely implement the plan.

CHECKLIST:
  PLAN COVERAGE — go through every plan step one by one. For each step, verify there is at least
    one edit whose relPath matches that step's relPath. Any plan step with no matching edit is a
    coverage gap — list it as an issue.
  EXISTENCE — no file that appears in the provided original files block should be marked isNew:true.
    Flag any such edit as an issue.
  CORRECTNESS — valid syntax, correct imports, correct function signatures, no obvious runtime errors
  COMPLETENESS — all wiring is done (routes, config, navigator, dependency manifest, scaffold files)
  CONSISTENCY — matches existing naming, indentation, style, framework patterns
  CONNECTIONS — imports match exports, routes point to real handlers, models are registered
  SAFETY — no hardcoded secrets, no SQL string concat, no shell injection

Be strict. Only approve if you are confident the edits produce working, production-quality code.
If rejecting, give specific, actionable issues — not vague feedback.`;
const REVIEW_TOOL_SCHEMA = {
    type: 'object',
    properties: {
        thinking: { type: 'string', description: 'Detailed review: go through each plan step and each edit against the checklist.' },
        approved: { type: 'boolean' },
        feedback: { type: 'string', description: 'Overall verdict in 1–3 sentences.' },
        issues: { type: 'array', items: { type: 'string' }, description: 'Specific actionable issues. Empty if approved.' },
    },
    required: ['thinking', 'approved', 'feedback', 'issues'],
};
async function reviewEdits(apiKey, model, plan, fileContents, edits) {
    const filesBlock = fileContents.length > 0
        ? fileContents.map((f) => `<file path="${f.relPath}">\n${f.content}\n</file>`).join('\n\n')
        : '(no existing files)';
    const messages = [{
            role: 'user',
            content: `PLAN:\n${formatPlanBlock(plan)}\n\n---\nORIGINAL FILES:\n\n${filesBlock}\n\n---\nPROPOSED EDITS:\n\n${formatEditsBlock(edits)}\n\nReview these edits.`,
        }];
    try {
        const result = await requestWithTool(apiKey, model, REVIEW_SYSTEM, messages, 'review_result', REVIEW_TOOL_SCHEMA, 4096);
        return {
            approved: result.approved ?? false,
            feedback: result.feedback ?? '',
            issues: result.issues ?? [],
        };
    }
    catch {
        // Reviewer failure → approve so the user is never silently blocked
        return { approved: true, feedback: 'Reviewer unavailable — applying as-is.', issues: [] };
    }
}
/* ============================================================
   ORCHESTRATOR
   Full pipeline: intent → plan → framework check → edits → validate → review.
============================================================ */
async function runAgent(apiKey, model, prompt, fileContents, history = []) {
    // 1. Intent check — skip the whole pipeline for non-coding inputs
    const intent = await classifyIntent(apiKey, model, history, prompt);
    if (intent !== 'code') {
        const reply = await chatReply(apiKey, model, history, prompt);
        return { reply, edits: [] };
    }
    // 2. Plan — ask the LLM what needs to change and in what order
    const plan = await createPlan(apiKey, model, history, prompt, fileContents);
    if (!plan.steps.length) {
        return { reply: plan.summary || 'No changes required.', edits: [] };
    }
    // 3. Generate edits
    const result = await generateEdits(apiKey, model, history, prompt, fileContents, plan);
    // 4. Validate edits against known file contents
    const { valid, skipped } = validateEdits(result.edits, fileContents);
    // 5. Plan coverage — list any steps that produced no edit
    const coverageGaps = validatePlanCoverage(plan, valid);
    // 6. Review
    const review = await reviewEdits(apiKey, model, plan, fileContents, valid);
    const allIssues = [...coverageGaps, ...review.issues];
    if (!review.approved) {
        return {
            reply: `Review rejected: ${review.issues.join('; ')}`,
            edits: [],
            skipped,
            issues: allIssues,
        };
    }
    return {
        reply: result.reply,
        edits: valid,
        skipped,
        issues: allIssues.length ? allIssues : undefined,
    };
}
//# sourceMappingURL=claudeClient.js.map