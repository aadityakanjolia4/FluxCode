import * as vscode from 'vscode';
import { WorkspaceIndexer } from './indexer';
import { CoWorkSidebar } from './sidebar';
import { FileWatcher } from './fileWatcher';

export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('AI CoWork');
  outputChannel.appendLine('AI CoWork activating...');

  // ── Core services ─────────────────────────────────────────────────────────
  const indexer = new WorkspaceIndexer(outputChannel, context.storageUri);
  await indexer.tryLoad(); // restore persisted index — instant if cache exists

  // ── Sidebar owns tab/agent lifecycle ──────────────────────────────────────
  const sidebar = new CoWorkSidebar(context, indexer, outputChannel);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CoWorkSidebar.viewId, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // ── File watcher (auto re-index on file creates/deletes) ──────────────────
  const watcher = new FileWatcher(indexer, outputChannel, () => {
    sidebar.triggerIndex();
  });
  watcher.start(context);
  context.subscriptions.push({ dispose: () => watcher.dispose() });

  // ── Commands ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('aiCowork.setApiKey', async () => {
      const current = vscode.workspace.getConfiguration('aiCowork').get<string>('apiKey') ?? '';
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your Anthropic API Key',
        password: true,
        placeHolder: 'sk-ant-...',
        value: current ? '(already set — type new key to replace)' : '',
        validateInput: (v) => {
          if (v === '(already set — type new key to replace)') { return null; }
          if (v && !v.startsWith('sk-ant-')) { return 'Key should start with sk-ant-'; }
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
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiCowork.indexWorkspace', () => {
      sidebar.triggerIndex();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiCowork.clearHistory', () => {
      sidebar.clearActiveTabHistory();
      vscode.window.showInformationMessage('AI CoWork: Conversation cleared');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('aiCowork.openChat', () => {
      vscode.commands.executeCommand(`${CoWorkSidebar.viewId}.focus`);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      outputChannel.appendLine('[Extension] Workspace folders changed');
      vscode.window.showInformationMessage(
        'AI CoWork: Workspace changed — please re-index.', 'Index Now'
      ).then((action) => {
        if (action === 'Index Now') { sidebar.triggerIndex(); }
      });
    })
  );

  outputChannel.appendLine('AI CoWork ready.');
}

export function deactivate() {}
