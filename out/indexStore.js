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
exports.IndexStore = void 0;
const vscode = __importStar(require("vscode"));
const INDEX_KEY_PREFIX = 'aiCowork.workspaceIndex';
class IndexStore {
    constructor(_context) {
        this._context = _context;
    }
    save(index) {
        const key = this._keyForRoot(index.root);
        this._context.globalState.update(key, index);
    }
    load() {
        const root = this._currentWorkspaceRoot();
        if (!root) {
            return null;
        }
        const key = this._keyForRoot(root);
        const stored = this._context.globalState.get(key);
        if (!stored || !this._isValidIndex(stored)) {
            return null;
        }
        if (stored.root !== root) {
            return null;
        }
        return stored;
    }
    _currentWorkspaceRoot() {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return null;
        }
        return folders[0].uri.fsPath;
    }
    _keyForRoot(root) {
        return `${INDEX_KEY_PREFIX}:${root}`;
    }
    _isValidIndex(value) {
        if (!value || typeof value !== 'object') {
            return false;
        }
        const idx = value;
        if (typeof idx.root !== 'string' || !Array.isArray(idx.files) || typeof idx.builtAt !== 'number') {
            return false;
        }
        return idx.files.every(this._isValidFileEntry);
    }
    _isValidFileEntry(file) {
        if (!file || typeof file !== 'object') {
            return false;
        }
        const f = file;
        return (typeof f.absPath === 'string' &&
            typeof f.relPath === 'string' &&
            typeof f.ext === 'string' &&
            typeof f.lines === 'number' &&
            Array.isArray(f.symbols) &&
            f.symbols.every((s) => typeof s === 'string') &&
            typeof f.size === 'number');
    }
}
exports.IndexStore = IndexStore;
//# sourceMappingURL=indexStore.js.map