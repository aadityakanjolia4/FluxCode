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
exports.extractImports = extractImports;
exports.extractSymbols = extractSymbols;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.dart', '.py', '.go'];
const INDEX_NAMES = EXTENSIONS.map(e => `index${e}`);
function resolveToActualFile(absPath) {
    if (fs.existsSync(absPath)) {
        return absPath;
    }
    for (const ext of EXTENSIONS) {
        const c = absPath + ext;
        if (fs.existsSync(c)) {
            return c;
        }
    }
    for (const idx of INDEX_NAMES) {
        const c = path.join(absPath, idx);
        if (fs.existsSync(c)) {
            return c;
        }
    }
    return null;
}
function extractImports(content, absFilePath, wsRoot) {
    const fileDir = path.dirname(absFilePath);
    const found = new Set();
    const importRegex = /(?:from|require\s*\(|import\s*\()\s*['"](\.[^'"]+)['"]/g;
    const reExportRegex = /export\s+(?:\*|\{[^}]*\})\s+from\s*['"](\.[^'"]+)['"]/g;
    const sideEffectRegex = /^\s*import\s+['"](\.[^'"]+)['"]/gm;
    for (const regex of [importRegex, reExportRegex, sideEffectRegex]) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(content)) !== null) {
            const rawImport = match[1];
            if (!rawImport?.startsWith('.')) {
                continue;
            }
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
function extractSymbols(content) {
    const exports = [];
    const allSymbols = [];
    for (const line of content.split('\n').slice(0, 300)) {
        const trimmed = line.trim();
        const match = trimmed.match(DECL_RE);
        if (!match) {
            continue;
        }
        const isExported = !!match[1];
        const name = match[2];
        allSymbols.push(name);
        if (isExported) {
            exports.push(name);
        }
    }
    return {
        exports: [...new Set(exports)].slice(0, 30),
        symbols: [...new Set(allSymbols)].slice(0, 30),
    };
}
//# sourceMappingURL=symbolExtractor.js.map