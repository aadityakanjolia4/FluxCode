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
exports.FileWatcher = void 0;
const vscode = __importStar(require("vscode"));
/**
 * Watches for file system changes and debounces re-indexing.
 * Only watches supported code files, not every file.
 */
class FileWatcher {
    constructor(indexer, outputChannel, onNeedsReindex) {
        this._watcher = null;
        this._debounceTimer = null;
        this._indexer = indexer;
        this._outputChannel = outputChannel;
        this._onNeedsReindex = onNeedsReindex;
    }
    start(context) {
        // Watch all supported file types
        this._watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx,mjs,py,go,rs,java,kt,cs,c,cpp,h,vue,svelte,json,yaml,yml,md,html,css,scss,sql,graphql,sh,prisma}');
        this._watcher.onDidCreate((uri) => {
            this._outputChannel.appendLine(`[Watcher] Created: ${uri.fsPath}`);
            this._scheduleReindex();
        }, null, context.subscriptions);
        this._watcher.onDidDelete((uri) => {
            this._outputChannel.appendLine(`[Watcher] Deleted: ${uri.fsPath}`);
            this._scheduleReindex();
        }, null, context.subscriptions);
        // Don't re-index on every save — too expensive. Only on create/delete.
        // But do patch the index for saves if we already have it.
        this._watcher.onDidChange((uri) => {
            this._patchIndexedFile(uri.fsPath);
        }, null, context.subscriptions);
        context.subscriptions.push(this._watcher);
        this._outputChannel.appendLine('[Watcher] File system watcher started');
    }
    _scheduleReindex() {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }
        // Wait 2s before re-indexing (batch rapid creates/deletes)
        this._debounceTimer = setTimeout(() => {
            if (this._indexer.index) {
                this._outputChannel.appendLine('[Watcher] Triggering re-index after file change');
                this._onNeedsReindex();
            }
        }, 2000);
    }
    /** Patch a single file's symbol entry in the index without full re-scan */
    _patchIndexedFile(absPath) {
        if (!this._indexer.index) {
            return;
        }
        this._indexer.patchFile(absPath);
    }
    dispose() {
        this._watcher?.dispose();
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }
    }
}
exports.FileWatcher = FileWatcher;
//# sourceMappingURL=fileWatcher.js.map