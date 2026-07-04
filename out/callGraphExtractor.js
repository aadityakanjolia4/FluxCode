"use strict";
/**
 * Function-level call graph extraction for surgical context selection.
 * Extracts function definitions, their calls, and builds bidirectional call graphs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractFunctionDefs = extractFunctionDefs;
exports.buildCallGraph = buildCallGraph;
exports.getSemanticContext = getSemanticContext;
/**
 * Extract function definitions from source code.
 * Supports: JS/TS functions, arrow functions, async functions, class methods.
 */
function extractFunctionDefs(content, relPath) {
    const functions = [];
    const lines = content.split('\n');
    // Pattern: function name(...) { or const name = (...) => { or async function name(...) {
    const fnRegex = /(?:(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)|(?:(?:export\s+)?const\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:async\s+)?\()|(?:(?:private|public|protected)?\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{))/g;
    let match;
    while ((match = fnRegex.exec(content)) !== null) {
        const name = match[1] || match[2] || match[3];
        if (!name)
            continue;
        const startIdx = match.index;
        const isExported = content.substring(Math.max(0, startIdx - 20), startIdx).includes('export');
        const isAsync = content.substring(Math.max(0, startIdx - 10), startIdx).includes('async');
        // Find opening brace
        let braceIdx = content.indexOf('{', startIdx);
        if (braceIdx === -1)
            continue;
        // Find matching closing brace (simple brace counter)
        let braceCount = 1;
        let closeIdx = braceIdx + 1;
        while (closeIdx < content.length && braceCount > 0) {
            if (content[closeIdx] === '{')
                braceCount++;
            else if (content[closeIdx] === '}')
                braceCount--;
            closeIdx++;
        }
        if (braceCount !== 0)
            continue;
        // Extract function body
        const body = content.substring(braceIdx + 1, closeIdx - 1);
        const lineStart = content.substring(0, startIdx).split('\n').length;
        const lineEnd = content.substring(0, closeIdx).split('\n').length;
        // Extract parameters
        const paramsMatch = content.substring(startIdx, braceIdx).match(/\(([^)]*)\)/);
        const parameters = paramsMatch ? paramsMatch[1] : '';
        // Extract return type (TS only)
        const returnMatch = content.substring(startIdx, braceIdx).match(/\):\s*([^{=]+?)(?:\s*[{=]|$)/);
        const returnType = returnMatch ? returnMatch[1].trim() : '';
        // Extract function calls within this function
        const calls = extractFunctionCalls(body);
        // Extract types used in signature
        const usesTypes = extractTypesFromSignature(parameters + ' ' + returnType);
        functions.push({
            name,
            relPath,
            lineStart,
            lineEnd,
            parameters,
            returnType,
            isAsync,
            isExported,
            calls,
            usesTypes,
        });
    }
    return functions;
}
/**
 * Extract function calls within a function body.
 * Looks for identifierName(...) patterns.
 */
function extractFunctionCalls(body) {
    const calls = new Set();
    // Match function calls: identifier(...)
    // Exclude: keywords, property access after dot
    const callRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
    const keywords = new Set([
        'if', 'for', 'while', 'switch', 'catch', 'function', 'class', 'async',
        'await', 'return', 'new', 'typeof', 'instanceof', 'const', 'let', 'var'
    ]);
    let match;
    while ((match = callRegex.exec(body)) !== null) {
        const name = match[1];
        if (!keywords.has(name)) {
            calls.add(name);
        }
    }
    return [...calls];
}
/**
 * Extract type names from function signature (parameters + return type).
 */
function extractTypesFromSignature(signature) {
    const types = new Set();
    // Match type identifiers: Type, Type<T>, Type | Type2
    const typeRegex = /\b([A-Z][a-zA-Z0-9_$]*)\b/g;
    let match;
    while ((match = typeRegex.exec(signature)) !== null) {
        types.add(match[1]);
    }
    return [...types];
}
/**
 * Build bidirectional call graphs from function definitions.
 */
function buildCallGraph(allFunctions) {
    const functions = new Map();
    const callsGraph = new Map();
    const calledByGraph = new Map();
    // Index functions by "relPath:name"
    for (const fn of allFunctions) {
        const key = `${fn.relPath}:${fn.name}`;
        functions.set(key, fn);
        callsGraph.set(key, new Set());
        calledByGraph.set(key, new Set());
    }
    // Build call edges
    for (const fn of allFunctions) {
        const fromKey = `${fn.relPath}:${fn.name}`;
        for (const calledName of fn.calls) {
            // Try to find the called function in the same file first
            const sameFileKey = `${fn.relPath}:${calledName}`;
            if (functions.has(sameFileKey)) {
                callsGraph.get(fromKey).add(sameFileKey);
                calledByGraph.get(sameFileKey).add(fromKey);
            }
            else {
                // Try to find in other files (by name)
                for (const otherFn of allFunctions) {
                    if (otherFn.name === calledName) {
                        const toKey = `${otherFn.relPath}:${otherFn.name}`;
                        callsGraph.get(fromKey).add(toKey);
                        calledByGraph.get(toKey).add(fromKey);
                        break; // Take first match
                    }
                }
            }
        }
    }
    return { functions, callsGraph, calledByGraph };
}
/**
 * Get semantic context for a function: itself + callees + direct callers.
 * Returns function definitions to include in context.
 */
function getSemanticContext(targetFunctionKey, graph, depth = 1) {
    const context = new Set();
    const queue = [[targetFunctionKey, 0]];
    while (queue.length > 0) {
        const [key, d] = queue.shift();
        if (context.has(key) || d > depth)
            continue;
        context.add(key);
        // Add callees
        const callees = graph.callsGraph.get(key);
        if (callees) {
            for (const callee of callees) {
                if (!context.has(callee) && d < depth) {
                    queue.push([callee, d + 1]);
                }
            }
        }
        // Add direct callers (only at depth 0)
        if (d === 0) {
            const callers = graph.calledByGraph.get(key);
            if (callers) {
                for (const caller of callers) {
                    if (!context.has(caller)) {
                        queue.push([caller, 1]);
                    }
                }
            }
        }
    }
    return [...context]
        .map(key => graph.functions.get(key))
        .filter(Boolean);
}
//# sourceMappingURL=callGraphExtractor.js.map