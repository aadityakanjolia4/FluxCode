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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const indexer_1 = require("./indexer");
const sidebar_1 = require("./sidebar");
const fileWatcher_1 = require("./fileWatcher");
function activate(context) {
    const outputChannel = vscode.window.createOutputChannel('AI CoWork');
    outputChannel.appendLine('AI CoWork activating...');
    // ── Core services ─────────────────────────────────────────────────────────
    const indexer = new indexer_1.WorkspaceIndexer(outputChannel);
    // ── Sidebar owns tab/agent lifecycle ──────────────────────────────────────
    const sidebar = new sidebar_1.CoWorkSidebar(context, indexer, outputChannel);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(sidebar_1.CoWorkSidebar.viewId, sidebar, {
        webviewOptions: { retainContextWhenHidden: true },
    }));
    // ── File watcher (auto re-index on file creates/deletes) ──────────────────
    const watcher = new fileWatcher_1.FileWatcher(indexer, outputChannel, () => {
        sidebar.triggerIndex();
    });
    watcher.start(context);
    context.subscriptions.push({ dispose: () => watcher.dispose() });
    // ── Commands ──────────────────────────────────────────────────────────────
    context.subscriptions.push(vscode.commands.registerCommand('aiCowork.setApiKey', async () => {
        const current = vscode.workspace.getConfiguration('aiCowork').get('apiKey') ?? '';
        const key = await vscode.window.showInputBox({
            prompt: 'Enter your Anthropic API Key',
            password: true,
            placeHolder: 'sk-ant-...',
            value: current ? '(already set — type new key to replace)' : '',
            validateInput: (v) => {
                if (v === '(already set — type new key to replace)') {
                    return null;
                }
                if (v && !v.startsWith('sk-ant-')) {
                    return 'Key should start with sk-ant-';
                }
                return null;
            },
        });
        if (key && key !== '(already set — type new key to replace)') {
            await vscode.workspace
                .getConfiguration('aiCowork')
                .update('apiKey', key, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage('AI CoWork: API key saved ✓');
            sidebar.notifyApiKeyChanged();
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('aiCowork.indexWorkspace', () => {
        sidebar.triggerIndex();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('aiCowork.clearHistory', () => {
        sidebar.clearActiveTabHistory();
        vscode.window.showInformationMessage('AI CoWork: Conversation cleared');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('aiCowork.openChat', () => {
        vscode.commands.executeCommand(`${sidebar_1.CoWorkSidebar.viewId}.focus`);
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        outputChannel.appendLine('[Extension] Workspace folders changed');
        vscode.window.showInformationMessage('AI CoWork: Workspace changed — please re-index.', 'Index Now').then((action) => {
            if (action === 'Index Now') {
                sidebar.triggerIndex();
            }
        });
    }));
    outputChannel.appendLine('AI CoWork ready.');
}
function deactivate() { }
//# sourceMappingURL=extension.js.map