import * as vscode from 'vscode';
import { WorkspaceIndexer } from './indexer';

/**
 * Watches for file system changes and debounces re-indexing.
 * Only watches supported code files, not every file.
 */
export class FileWatcher {
  private _watcher: vscode.FileSystemWatcher | null = null;
  private _debounceTimer: NodeJS.Timeout | null = null;
  private _onNeedsReindex: () => void;
  private _indexer: WorkspaceIndexer;
  private _outputChannel: vscode.OutputChannel;

  constructor(
    indexer: WorkspaceIndexer,
    outputChannel: vscode.OutputChannel,
    onNeedsReindex: () => void
  ) {
    this._indexer = indexer;
    this._outputChannel = outputChannel;
    this._onNeedsReindex = onNeedsReindex;
  }

  start(context: vscode.ExtensionContext): void {
    // Watch all supported file types
    this._watcher = vscode.workspace.createFileSystemWatcher(
      '**/*.{ts,tsx,js,jsx,mjs,py,go,rs,java,kt,cs,c,cpp,h,vue,svelte,json,yaml,yml,md,html,css,scss,sql,graphql,sh,prisma}'
    );

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

  private _scheduleReindex(): void {
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
  private _patchIndexedFile(absPath: string): void {
    if (!this._indexer.index) { return; }
    this._indexer.patchFile(absPath);
  }

  dispose(): void {
    this._watcher?.dispose();
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); }
  }
}
