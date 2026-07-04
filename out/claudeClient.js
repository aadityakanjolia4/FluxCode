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
exports.setLogger = setLogger;
exports.getTokenTracker = getTokenTracker;
exports.getSessionTokens = getSessionTokens;
exports.resetTokens = resetTokens;
exports.classifyIntent = classifyIntent;
exports.classifyComplexity = classifyComplexity;
exports.validateEdits = validateEdits;
exports.validatePlanCoverage = validatePlanCoverage;
exports.fuzzyFindReplace = fuzzyFindReplace;
exports.applyEditsToMemory = applyEditsToMemory;
exports.inferCodeStyle = inferCodeStyle;
exports.chatReply = chatReply;
exports.selectFiles = selectFiles;
exports.selectFilesForChat = selectFilesForChat;
exports.createPlan = createPlan;
exports.generateEdits = generateEdits;
exports.generateEditsParallel = generateEditsParallel;
exports.reviewEdits = reviewEdits;
exports.thinkAboutQuery = thinkAboutQuery;
const https = __importStar(require("https"));
const tokenTracker_1 = require("./tokenTracker");
let _logger;
let _tokenTracker = new tokenTracker_1.TokenTracker();
function setLogger(fn) { _logger = fn; }
/**
 * Get token tracker instance for monitoring usage
 */
function getTokenTracker() {
    return _tokenTracker;
}
/**
 * Get session token statistics
 */
function getSessionTokens() {
    return _tokenTracker.getSessionStats();
}
/**
 * Reset token tracker (for new session)
 */
function resetTokens() {
    _tokenTracker.clear();
}
const GEMINI_MAX_OUTPUT_TOKENS = 65536; // 64K output
// ─── Recency helpers ──────────────────────────────────────────────────────────
function formatAge(ageMs) {
    const sec = ageMs / 1000;
    const min = sec / 60;
    const hour = min / 60;
    const day = hour / 24;
    if (sec < 60) {
        return `${Math.round(sec)}s ago`;
    }
    if (min < 60) {
        return `${Math.round(min)}m ago`;
    }
    if (hour < 24) {
        return `${Math.round(hour)}h ago`;
    }
    return `${Math.round(day)}d ago`;
}
/**
 * Converts history to the Claude messages format, prefixing each message
 * with its age so the model can weight recent context more heavily.
 */
function stampedHistory(history) {
    const now = Date.now();
    return history.map(m => ({
        role: m.role,
        content: m.timestamp ? `[${formatAge(now - m.timestamp)}] ${m.content}` : m.content,
    }));
}
/* ============================================================
   INTENT CLASSIFIER
   Classifies a user prompt so the pipeline can skip code generation
   for questions, explanations, and accidental inputs.
============================================================ */
const CLASSIFY_SYSTEM = `You are an intent classifier for a VS Code AI coding assistant.

PRIMARY RULE: Base your decision almost entirely on the LAST user message. History is only a tiebreaker for very short/ambiguous messages (e.g. "fix it", "do it", "yes").

Classify as:
- "command" — shell/git/build operations: install, commit, push, build, create vsix, run, execute, npm, pip, git, docker, etc.
- "code"    — the last message wants to CREATE, EDIT, FIX, REFACTOR, DELETE, or otherwise CHANGE SOURCE CODE or files
- "question" — the last message is ASKING something, wants an EXPLANATION, or seeks INFORMATION (no file/command changes)

COMMAND KEYWORDS: install, commit, push, pull, build, create, run, execute, npm, pip, git, docker, rebuild, package, deploy, start, stop, restart, migrate, sync, clone, fetch, merge, rebase, tag, branch, checkout

If the last message clearly states its intent on its own, ignore history entirely.

Reply with ONLY the single word: command  OR  code  OR  question`;
async function classifyIntent(apiKey, model, history, prompt) {
    if (!prompt.trim()) {
        return 'noop';
    }
    try {
        const messages = [
            // Last 4 messages of history give enough context for follow-ups
            ...stampedHistory(history.slice(-4)),
            { role: 'user', content: prompt },
        ];
        const result = await request(apiKey, model, CLASSIFY_SYSTEM, messages, 5, 'classifyIntent');
        const intent = result.trim().toLowerCase();
        if (intent.startsWith('command'))
            return 'command';
        if (intent.startsWith('question'))
            return 'question';
        return 'code';
    }
    catch {
        // On any API failure, default to code pipeline (planner handles non-code gracefully)
        return 'code';
    }
}
const COMPLEXITY_SYSTEM = `You are a task complexity classifier for a coding assistant.

Classify the coding task as one of:
- "trivial" — single localised edit that touches one spot: rename, typo fix, add/remove one import, change a constant, adjust formatting, write a one-liner
- "complex" — everything else: bug fixes, new functions, refactors, new features, multi-file changes, anything that requires reading existing code to implement correctly

When in doubt, choose "complex".

Base your decision on the LAST user message. History is context only.

Reply with ONLY one word: trivial  OR  complex`;
async function classifyComplexity(apiKey, model, history, prompt) {
    try {
        const messages = [
            ...stampedHistory(history.slice(-4)),
            { role: 'user', content: prompt },
        ];
        const result = await request(apiKey, model, COMPLEXITY_SYSTEM, messages, 5, 'classifyComplexity');
        return result.trim().toLowerCase().startsWith('trivial') ? 'trivial' : 'complex';
    }
    catch {
        return 'complex'; // safe default on API failure
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
        else if (edit.command) {
            valid.push(edit);
        }
        else {
            if (!edit.oldString) {
                skipped.push({ edit, reason: `Snippet edit for "${edit.relPath}" has no oldString` });
                continue;
            }
            // Only validate against known content — unread files pass through.
            // Use fuzzyFindReplace so validation uses the same matching as apply time:
            // an edit that would fail at apply time is skipped here, and vice-versa.
            const content = contentMap.get(edit.relPath);
            if (content !== undefined && fuzzyFindReplace(content, edit.oldString ?? '', '') === null) {
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
// fuzzyFindReplace — replace oldStr in current with newStr.
// Falls back to whitespace-normalised matching when exact match fails, handling
// the common case where trailing whitespace or line-ending differences between
// the indexed snapshot and the live file cause a literal includes() to miss.
// Returns the updated string, or null if no match could be found at any level.
function fuzzyFindReplace(current, oldStr, newStr) {
    // 1. Exact match — fastest path, preserves all original whitespace
    if (current.includes(oldStr)) {
        return current.replace(oldStr, newStr);
    }
    // 2. Normalise line endings (CRLF → LF) and retry
    const normCurrent = current.replace(/\r\n/g, '\n');
    const normOld = oldStr.replace(/\r\n/g, '\n');
    const normNew = newStr.replace(/\r\n/g, '\n');
    if (normCurrent.includes(normOld)) {
        return normCurrent.replace(normOld, normNew);
    }
    // 3. Trim trailing whitespace per line — line-based sliding-window search.
    //    Preserves original leading whitespace (indentation) of surrounding lines.
    const currentLines = normCurrent.split('\n');
    const oldLines = normOld.split('\n').map(l => l.trimEnd());
    if (oldLines.length === 0) {
        return null;
    }
    for (let i = 0; i <= currentLines.length - oldLines.length; i++) {
        const slice = currentLines.slice(i, i + oldLines.length).map(l => l.trimEnd());
        if (slice.join('\n') === oldLines.join('\n')) {
            return [
                ...currentLines.slice(0, i),
                ...normNew.split('\n'),
                ...currentLines.slice(i + oldLines.length),
            ].join('\n');
        }
    }
    return null; // no match at any normalisation level
}
// applyEditsToMemory — produce before/after pairs for the reviewer.
// Applies edits in memory without touching disk. New files appear with before: ''.
function applyEditsToMemory(fileContents, edits) {
    const map = new Map(fileContents.map(f => [f.relPath, f.content]));
    for (const edit of edits) {
        if (edit.isNew) {
            map.set(edit.relPath ?? '', edit.newContent ?? '');
        }
        else {
            const current = map.get(edit.relPath ?? '') ?? '';
            map.set(edit.relPath ?? '', fuzzyFindReplace(current, edit.oldString ?? '', edit.newString ?? '') ?? current);
        }
    }
    const result = fileContents.map(f => ({
        relPath: f.relPath,
        before: f.content,
        after: map.get(f.relPath) ?? f.content,
    }));
    // Append new files that were not in fileContents
    for (const edit of edits) {
        if (edit.isNew && !fileContents.some(f => f.relPath === edit.relPath)) {
            result.push({ relPath: edit.relPath ?? '', before: '', after: edit.newContent ?? '' });
        }
    }
    return result;
}
/* ============================================================
   HTTP
============================================================ */
// ─── Provider detection ───────────────────────────────────────────────────────
function isMistralModel(model) {
    return /^(mistral|codestral|open-mistral|open-codestral|pixtral|magistral)/i.test(model);
}
function isGeminiModel(model) {
    return /^gemini/i.test(model);
}
// Converts standard {role, content} messages to Gemini's contents format.
// Gemini uses "model" instead of "assistant" and requires strict user/model alternation.
function toGeminiContents(messages) {
    return messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
    }));
}
function httpPost(hostname, path, headers, body) {
    return new Promise((resolve, reject) => {
        const options = { hostname, path, method: 'POST', headers };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
function logTokens(label, model, input, output) {
    if (!_logger) {
        return;
    }
    const i = input !== undefined ? input.toLocaleString() : '?';
    const o = output !== undefined ? output.toLocaleString() : '?';
    _logger(`[Tokens] ${label} (${model})  in: ${i}  out: ${o}`);
    // Track tokens
    if (input !== undefined && output !== undefined) {
        const provider = model.startsWith('claude') ? 'anthropic' :
            model.startsWith('gemini') ? 'gemini' : 'mistral';
        _tokenTracker.trackTokens(provider, input, output);
    }
}
async function request(apiKey, model, system, messages, maxTokens = 8000, label = 'request') {
    return withRetry(async () => {
        if (isGeminiModel(model)) {
            // Gemini — system_instruction + contents with user/model roles
            const body = JSON.stringify({
                system_instruction: { parts: [{ text: system }] },
                contents: toGeminiContents(messages),
                generationConfig: { maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS },
            });
            const raw = await httpPost('generativelanguage.googleapis.com', `/v1beta/models/${model}:generateContent?key=${apiKey}`, {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            }, body);
            const parsed = JSON.parse(raw);
            if (parsed.error) {
                throw new Error(`Gemini API: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
            }
            logTokens(label, model, parsed.usageMetadata?.promptTokenCount, parsed.usageMetadata?.candidatesTokenCount);
            return parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        }
        if (isMistralModel(model)) {
            // Mistral — OpenAI-compatible format, system as first message
            const body = JSON.stringify({
                model, max_tokens: maxTokens,
                messages: [{ role: 'system', content: system }, ...messages],
            });
            const raw = await httpPost('api.mistral.ai', '/v1/chat/completions', {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(body),
            }, body);
            const parsed = JSON.parse(raw);
            if (parsed.error) {
                throw new Error(`Mistral API: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
            }
            logTokens(label, model, parsed.usage?.prompt_tokens, parsed.usage?.completion_tokens);
            return parsed.choices?.[0]?.message?.content ?? '';
        }
        // Anthropic
        const body = JSON.stringify({ model, max_tokens: maxTokens, system, messages });
        const raw = await httpPost('api.anthropic.com', '/v1/messages', {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(body),
        }, body);
        const parsed = JSON.parse(raw);
        if (parsed.error) {
            throw new Error(`API: ${parsed.error.message}`);
        }
        logTokens(label, model, parsed.usage?.input_tokens, parsed.usage?.output_tokens);
        return parsed.content?.[0]?.text ?? '';
    });
}
async function requestWithTool(apiKey, model, system, messages, toolName, toolSchema, maxTokens = 8000, label = 'requestWithTool') {
    return withRetry(async () => {
        if (isGeminiModel(model)) {
            // Gemini function calling — function_declarations + tool_config
            const body = JSON.stringify({
                system_instruction: { parts: [{ text: system }] },
                contents: toGeminiContents(messages),
                tools: [{ function_declarations: [{ name: toolName, description: 'Return the structured result', parameters: toolSchema }] }],
                tool_config: { function_calling_config: { mode: 'ANY' } },
                generationConfig: { maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS },
            });
            const raw = await httpPost('generativelanguage.googleapis.com', `/v1beta/models/${model}:generateContent?key=${apiKey}`, {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            }, body);
            const parsed = JSON.parse(raw);
            if (parsed.error) {
                throw new Error(`Gemini API: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
            }
            logTokens(label, model, parsed.usageMetadata?.promptTokenCount, parsed.usageMetadata?.candidatesTokenCount);
            const part = parsed.candidates?.[0]?.content?.parts?.[0];
            if (part?.functionCall?.args) {
                return part.functionCall.args;
            }
            const fallback = part?.text ?? '(empty)';
            throw new Error(`No functionCall in Gemini response. Text: ${String(fallback).slice(0, 200)}`);
        }
        if (isMistralModel(model)) {
            // Mistral function calling — OpenAI-compatible tool use
            const body = JSON.stringify({
                model, max_tokens: maxTokens,
                messages: [{ role: 'system', content: system }, ...messages],
                tools: [{ type: 'function', function: { name: toolName, description: 'Return the structured result', parameters: toolSchema } }],
                tool_choice: 'any',
            });
            const raw = await httpPost('api.mistral.ai', '/v1/chat/completions', {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(body),
            }, body);
            const parsed = JSON.parse(raw);
            if (parsed.error) {
                throw new Error(`Mistral API: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
            }
            if (parsed.choices?.[0]?.finish_reason === 'length') {
                throw new Error('Response hit max_tokens. Try fewer/smaller files.');
            }
            logTokens(label, model, parsed.usage?.prompt_tokens, parsed.usage?.completion_tokens);
            const toolCall = parsed.choices?.[0]?.message?.tool_calls?.[0];
            if (toolCall?.function?.arguments) {
                return JSON.parse(toolCall.function.arguments);
            }
            const fallback = parsed.choices?.[0]?.message?.content ?? '(empty)';
            throw new Error(`No tool_call block. Text: ${String(fallback).slice(0, 200)}`);
        }
        // Anthropic
        const body = JSON.stringify({
            model, max_tokens: maxTokens, system, messages,
            tools: [{ name: toolName, description: 'Return the structured result', input_schema: toolSchema }],
            tool_choice: { type: 'tool', name: toolName },
        });
        const raw = await httpPost('api.anthropic.com', '/v1/messages', {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(body),
        }, body);
        const parsed = JSON.parse(raw);
        if (parsed.error) {
            throw new Error(`API: ${parsed.error.message}`);
        }
        if (parsed.stop_reason === 'max_tokens') {
            throw new Error('Response hit max_tokens. Try fewer/smaller files.');
        }
        logTokens(label, model, parsed.usage?.input_tokens, parsed.usage?.output_tokens);
        const toolUse = (parsed.content ?? []).find((b) => b.type === 'tool_use');
        if (toolUse?.input) {
            return toolUse.input;
        }
        const fallback = parsed.content?.[0]?.text ?? '(empty)';
        throw new Error(`No tool_use block. Text: ${fallback.slice(0, 200)}`);
    });
}
/* ============================================================
   CHAT REPLY — conversational responses (no code changes)
============================================================ */
/* ============================================================
   STYLE INFERENCE — samples top files to learn codebase conventions
============================================================ */
const STYLE_SYSTEM = `You are a code style analyst. Analyze the provided source files and extract the developer's coding conventions as 6-8 concise bullet points.

Focus on:
- How external API/HTTP calls are structured (inline vs dedicated wrapper functions — this is critical)
- Function naming and signature patterns (e.g. snake_case, camelCase, parameter order)
- Error handling approach (try/except, if/else, explicit checks)
- How results/responses are returned or logged
- Import/module organization
- Any repeated structural patterns across files

Output ONLY bullet points starting with "•". No intro. No headers. Be specific to what you actually see in the code.`;
async function inferCodeStyle(apiKey, model, fileContents) {
    const filesBlock = fileContents
        .map(f => `<file path="${f.relPath}">\n${f.content.slice(0, 3000)}\n</file>`)
        .join('\n\n');
    const result = await request(apiKey, model, STYLE_SYSTEM, [{ role: 'user', content: filesBlock }], 512, 'inferCodeStyle');
    return result.trim();
}
/* ============================================================
   CHAT REPLY
============================================================ */
const CHAT_SYSTEM = `You are a helpful AI coding assistant integrated into VS Code. When file contents are provided, read them carefully and base your answer on the actual code — reference specific functions, variables, and logic you see. Combine what you find in the code with your own knowledge to give a complete, accurate answer. Be concise but thorough — use markdown formatting (code blocks, bullet points) where it helps clarity.

History messages are prefixed with their age (e.g. [2m ago], [1h ago], [3d ago]). Weight recent messages more heavily — they reflect the user's current focus. Older messages are context only.`;
async function chatReply(apiKey, model, history, userPrompt, fileContents = []) {
    let userContent = userPrompt;
    if (fileContents.length > 0) {
        const filesBlock = fileContents
            .map(f => `<file path="${f.relPath}">\n${f.content}\n</file>`)
            .join('\n\n');
        userContent = `${filesBlock}\n\n${userPrompt}`;
    }
    const messages = [
        ...stampedHistory(history),
        { role: 'user', content: userContent },
    ];
    return request(apiKey, model, CHAT_SYSTEM, messages, 2048, 'chatReply');
}
/* ============================================================
   AGENT 1: FILE SELECTOR
============================================================ */
const CHAT_FILE_SELECTION_SYSTEM = `You are the file selector for an AI coding assistant answering a user's question. You receive a workspace graph that lists every file with its language, size, centrality score, import edges, and symbol metadata — functions and classes with exact line ranges.

Your job: identify the MINIMUM set of specific code pieces the assistant needs to READ in order to accurately answer the question. Do NOT select files to change — select files to understand.

━━━ HOW TO SELECT ━━━

1. FOCUS ON THE QUESTION
   What is the user asking about? Identify the concept, function, module, or behaviour they want explained.

2. SELECT THE MOST RELEVANT CODE
   - The specific function/class the question is about (use line ranges when the file is large)
   - Types, interfaces, or schemas it references
   - Callers or usages if the question is about how something is used
   - Config or wiring only if the question is about setup/integration

3. STAY MINIMAL
   If you can answer the question with one function, don't select the whole file.
   Maximum 8 selections — fewer is better.

━━━ OUTPUT ━━━
Use the select_files tool. Exact paths only — from the graph. Return [] if no files are needed to answer the question.`;
const FILE_SELECTION_SYSTEM = `You are the file selector for an AI coding assistant. You receive a workspace graph that lists every file with its language, size, centrality score, import edges, and symbol metadata — functions and classes with exact line ranges.

Your job: identify the MINIMUM set of specific code pieces that gives the assistant everything it needs to implement the task. Prefer granular selections (a specific function or class by line range) over whole-file selections — this keeps context tight and focused.

━━━ HOW TO SELECT ━━━

1. IDENTIFY THE STACK
   Read file names, extensions, and import edges to detect the framework and architecture.

2. SELECT BACKBONE PIECES
   Every stack has essential files. Include the specific parts relevant to the task:
   - Shared types / interfaces (usually small — whole file is fine)
   - Entry point or bootstrap (just the section that wires up the affected feature)
   - Routing / registration file if the task adds a new feature
   - Config / schema if the task touches data shape

3. SELECT REQUEST-SPECIFIC CODE
   For each file the task directly touches, identify the SPECIFIC function or class.
   - If the file is small (<80L) or you need the full module structure: whole file (omit lineStart/lineEnd)
   - Otherwise: select just the relevant function or class using the line range from the graph

4. REGISTRATION AND WIRING
   Always include the file that mounts or registers new features — without it the planner misses the wiring step.

━━━ GRANULARITY RULE ━━━
One focused function (30 lines) beats three whole files (300 lines).
Only select a whole file when you genuinely need to see the full structure.

━━━ OUTPUT ━━━
Use the select_files tool. Maximum 15 selections. Exact paths only — from the graph.

History messages are prefixed with their age (e.g. [2m ago], [1h ago], [3d ago]). Prioritise recent messages — they show what the user is currently working on.`;
const SELECT_FILES_TOOL_SCHEMA = {
    type: 'object',
    properties: {
        thinking: {
            type: 'string',
            description: 'Stack detected. What the task needs. Which specific functions/classes are relevant and why.',
        },
        selections: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    relPath: { type: 'string', description: 'Relative file path exactly as shown in the graph.' },
                    lineStart: { type: 'number', description: 'First line of the function or class (1-indexed). Omit for whole-file selection.' },
                    lineEnd: { type: 'number', description: 'Last line of the function or class (1-indexed). Omit for whole-file selection.' },
                },
                required: ['relPath'],
            },
            maxItems: 15,
        },
    },
    required: ['thinking', 'selections'],
};
async function runFileSelector(systemPrompt, callerTag, apiKey, model, fileTree, history, userPrompt) {
    const messages = [
        ...stampedHistory(history),
        { role: 'user', content: `Workspace graph:\n\n${fileTree}\n\n---\nRequest: ${userPrompt}` },
    ];
    try {
        const result = await requestWithTool(apiKey, model, systemPrompt, messages, 'select_files', SELECT_FILES_TOOL_SCHEMA, 2048, callerTag);
        const selections = (result.selections ?? [])
            .filter(s => !!s.relPath)
            .map(s => ({
            relPath: s.relPath,
            ...(s.lineStart && s.lineEnd ? { lineStart: s.lineStart, lineEnd: s.lineEnd } : {}),
        }));
        return { selections, thinking: result.thinking ?? '' };
    }
    catch {
        return { selections: [], thinking: '' };
    }
}
function selectFiles(apiKey, model, fileTree, history, userPrompt) {
    return runFileSelector(FILE_SELECTION_SYSTEM, 'selectFiles', apiKey, model, fileTree, history, userPrompt);
}
function selectFilesForChat(apiKey, model, fileTree, history, userPrompt) {
    return runFileSelector(CHAT_FILE_SELECTION_SYSTEM, 'selectFilesForChat', apiKey, model, fileTree, history.slice(-4), userPrompt);
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

Do NOT write actual code. Describe intent only.

History messages are prefixed with their age (e.g. [2m ago], [1h ago], [3d ago]). Weight recent messages more heavily — they define the current task. Older messages are background context only.`;
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
        ...stampedHistory(history),
        { role: 'user', content: `Files:\n\n${filesBlock}\n\n---\nTask: ${userPrompt}\n\nCreate an implementation plan.` },
    ];
    const result = await requestWithTool(apiKey, model, PLAN_SYSTEM, messages, 'create_plan', PLAN_TOOL_SCHEMA, 4096, 'createPlan');
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
The provided files are your style guide. Read them carefully and match EXACTLY:

- Indentation: spaces vs tabs, how many — copy it precisely
- Quote style: single, double, backtick — match what the file uses
- Semicolons: if the file uses them, use them; if not, don't
- Naming: variables, functions, classes — match the exact convention (camelCase, snake_case, PascalCase, _prefix, etc.)
- How similar features are already implemented — replicate that structure exactly, do not invent a new approach
- How imports are written and ordered — follow the same grouping and style
- Existing helpers, utilities, base classes — USE them, never duplicate
- Error handling: if the file uses try/catch, use try/catch; if it uses Result types or if/else checks, do the same
- Null checks: if the file uses ??, use ??; if it uses ||, use ||
- Function style: if the file uses arrow functions for X, use arrow functions; if it uses function keyword, use that
Your code must be indistinguishable from the existing code — a reviewer should not be able to tell which lines you wrote.

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

━━━ TERMINAL COMMANDS ━━━
You can optionally execute terminal commands to automate tasks (e.g., npm install, git operations, build steps, or any shell command). Include a command field in your edits:
  • command: "npm install" or "git add ." or any valid shell command
  • The command will be executed in the workspace root directory
  • Use this ONLY when necessary — prefer code edits when possible
  • Example use cases: install dependencies, rebuild, format code, run migrations
  • Commands execute in order, like edits

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
If you receive reviewer feedback, fix EVERY listed issue. Do not resubmit with the same problems.

History messages are prefixed with their age (e.g. [2m ago], [1h ago], [3d ago]). Weight recent messages more heavily — they define the current task. Older messages are background context only.`;
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
                    command: { type: 'string', description: 'Optional: terminal command to execute (e.g., "npm install", "git add .", "npm run build"). Executed in the workspace root. Use only when necessary.' },
                },
                required: ['summary'],
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
function formatBeforeAfterBlock(files) {
    return files.map((f) => {
        if (!f.before) {
            return `<new_file path="${f.relPath}">\n${f.after}\n</new_file>`;
        }
        if (f.before === f.after) {
            return `<file path="${f.relPath}" unchanged="true">\n${f.after}\n</file>`;
        }
        return `<file path="${f.relPath}">\nBEFORE:\n${f.before}\n\nAFTER:\n${f.after}\n</file>`;
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
        ...stampedHistory(history),
        { role: 'user', content: userContent },
    ];
    const result = await requestWithTool(apiKey, model, EDIT_SYSTEM, messages, 'apply_edits', EDIT_TOOL_SCHEMA, 32000, 'generateEdits');
    const edits = (result.edits ?? []).map((e) => ({
        relPath: e.relPath ?? '',
        isNew: e.isNew ?? false,
        summary: e.summary ?? '',
        newContent: e.newContent,
        oldString: e.oldString,
        newString: e.newString,
        command: e.command,
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
const REVIEW_SYSTEM = `You are a strict senior code reviewer.

You will receive:
1. An implementation plan
2. BEFORE and AFTER states of files

Your job is to evaluate the AFTER state thoroughly.

━━━ EVALUATION DIMENSIONS (MANDATORY) ━━━

1. PLAN COVERAGE
- Verify every plan step is implemented
- If any step has no corresponding change → issue

2. CORRECTNESS
- Syntax, imports, references, logic errors

3. CONSISTENCY (STRICT)
- Must follow existing project conventions:
  - naming (camelCase/snake_case)
  - API usage (wrappers vs direct calls)
  - error handling patterns
  - imports structure
- Any deviation → issue

4. BETTER APPROACH DETECTION (MANDATORY)
- Check if:
  - existing helper/util could be reused
  - logic is duplicated
  - a more idiomatic pattern exists in codebase
- If yes: flag issue, suggest exact better alternative, explain why

5. CODE QUALITY
- readability, modularity, separation of concerns
- avoid unnecessary complexity

6. PERFORMANCE / SAFETY
- inefficient patterns, potential risks
- no hardcoded secrets, no SQL string concat, no shell injection

━━━ PROCESS ━━━
Perform 3 passes:
  1. correctness
  2. consistency
  3. quality & improvements

Return ALL issues found. Do NOT stop after the first issue.

Be strict. Prefer rejecting over approving.`;
const REVIEW_TOOL_SCHEMA = {
    type: 'object',
    properties: {
        thinking: { type: 'string', description: '3-pass review: correctness → consistency → quality. Go through each plan step and each file.' },
        approved: { type: 'boolean' },
        feedback: { type: 'string', description: 'Overall verdict in 1–3 sentences.' },
        issues: {
            type: 'array',
            description: 'All issues found across all passes. Empty if approved.',
            items: {
                type: 'object',
                properties: {
                    type: { type: 'string', enum: ['correctness', 'consistency', 'quality', 'performance'] },
                    file: { type: 'string', description: 'Relative file path' },
                    message: { type: 'string', description: 'What is wrong' },
                    suggestion: { type: 'string', description: 'How to fix it — specific and actionable' },
                },
                required: ['type', 'file', 'message', 'suggestion'],
            },
        },
    },
    required: ['thinking', 'approved', 'feedback', 'issues'],
};
async function reviewEdits(apiKey, model, plan, fileContents, edits) {
    const postEdit = applyEditsToMemory(fileContents, edits);
    const filesBlock = postEdit.length > 0 ? formatBeforeAfterBlock(postEdit) : '(no files)';
    const messages = [{
            role: 'user',
            content: `PLAN:\n${formatPlanBlock(plan)}\n\n---\nFILES (before → after):\n\n${filesBlock}\n\nReview these changes.`,
        }];
    try {
        const result = await requestWithTool(apiKey, model, REVIEW_SYSTEM, messages, 'review_result', REVIEW_TOOL_SCHEMA, 4096, 'reviewEdits');
        const issues = (result.issues ?? []).map(i => ({
            type: (i.type ?? 'correctness'),
            file: i.file ?? '',
            message: i.message ?? '',
            suggestion: i.suggestion ?? '',
        }));
        return { approved: result.approved ?? false, feedback: result.feedback ?? '', issues };
    }
    catch {
        return { approved: true, feedback: 'Reviewer unavailable — applying as-is.', issues: [] };
    }
}
async function thinkAboutQuery(apiKey, model, history, prompt) {
    const messages = [
        ...stampedHistory(history),
        {
            role: 'user',
            content: `Analyze this query. What approach should I take? What files/patterns are relevant? What complexity is this?

Query: "${prompt}"

Return JSON with:
- approach: "brief description of how to solve this"
- searchTerms: ["term1", "term2", ...] (what to search for in the codebase)
- estimatedComplexity: "trivial" | "simple" | "complex"
- needsResearch: boolean (should I gather context first?)`,
        },
    ];
    const THINKING_SCHEMA = {
        type: 'object',
        properties: {
            approach: { type: 'string', description: 'How to approach this task' },
            searchTerms: { type: 'array', items: { type: 'string' }, description: 'What to search for' },
            estimatedComplexity: { type: 'string', enum: ['trivial', 'simple', 'complex'] },
            needsResearch: { type: 'boolean', description: 'Should we research first?' },
        },
        required: ['approach', 'searchTerms', 'estimatedComplexity', 'needsResearch'],
    };
    try {
        const result = await requestWithTool(apiKey, model, 'You are an expert code analyst.', messages, 'thinking_result', THINKING_SCHEMA, 1024, 'thinkAboutQuery');
        return result;
    }
    catch (e) {
        _logger?.(`[Thinking] Error: ${e}`);
        return {
            approach: 'Analyze the code and fulfill the request',
            searchTerms: prompt.split(/\s+/).filter(t => t.length > 3),
            estimatedComplexity: 'simple',
            needsResearch: false,
        };
    }
}
//# sourceMappingURL=claudeClient.js.map