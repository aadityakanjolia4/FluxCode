import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { CoWorkAgent } from './agent';
import { WorkspaceIndexer } from './indexer';
import { HistoryStore } from './historyStore';
import { ExtToWeb, WebToExt, MessageContext } from './types';

interface TabEntry {
  agent: CoWorkAgent;
  label: string;
  uuid: string;
}

export class CoWorkSidebar implements vscode.WebviewViewProvider {
  public static readonly viewId = 'aiCowork.chatView';
  private _view?: vscode.WebviewView;
  private _indexer: WorkspaceIndexer;
  private _outputChannel: vscode.OutputChannel;

  // ── Tab management ────────────────────────────────────────────────────────
  private _tabs = new Map<number, TabEntry>();
  private _nextTabId = 1;
  private _activeTabId = 1;

  // ── Editor context tracking ───────────────────────────────────────────────
  private _currentEditorCtx: ExtToWeb & { type: 'editorContext' } = { type: 'editorContext', hasSelection: false };

  constructor(
    private readonly _context: vscode.ExtensionContext,
    indexer: WorkspaceIndexer,
    outputChannel: vscode.OutputChannel
  ) {
    this._indexer = indexer;
    this._outputChannel = outputChannel;
    const registry = this._context.workspaceState.get<Array<{ uuid: string; label: string }>>('aiCowork.tabRegistry') ?? [];
    if (registry.length === 0) {
      this._addTab(this._nextTabId++, randomUUID());
      this._saveTabRegistry();
    } else {
      for (const entry of registry) {
        this._addTab(this._nextTabId++, entry.uuid, entry.label);
      }
    }

    // Track active editor and selection changes
    this._context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(e => this._updateEditorCtx(e)),
      vscode.window.onDidChangeTextEditorSelection(e => {
        if (e.textEditor === vscode.window.activeTextEditor) {
          this._updateEditorCtx(e.textEditor);
        }
      })
    );
    this._updateEditorCtx(vscode.window.activeTextEditor);
  }

  private _updateEditorCtx(editor?: vscode.TextEditor) {
    if (!editor || editor.document.uri.scheme !== 'file') {
      this._currentEditorCtx = { type: 'editorContext', hasSelection: false };
    } else {
      const absPath = editor.document.uri.fsPath;
      const wsRoot = this._indexer.getRoot() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const relPath = wsRoot ? path.relative(wsRoot, absPath) : path.basename(absPath);
      const sel = editor.selection;
      const hasSelection = !sel.isEmpty;
      this._currentEditorCtx = {
        type: 'editorContext',
        absPath,
        relPath,
        hasSelection,
        ...(hasSelection && { startLine: sel.start.line + 1, endLine: sel.end.line + 1 }),
      };
    }
    this._post(this._currentEditorCtx);
  }

  private _addTab(tabId: number, uuid: string, label = `Chat ${tabId}`): TabEntry {
    const store = new HistoryStore(this._context, uuid);
    const agent = new CoWorkAgent(this._indexer, this._outputChannel, store);
    const entry: TabEntry = { agent, label, uuid };
    this._tabs.set(tabId, entry);
    return entry;
  }

  private _saveTabRegistry(): void {
    const registry = [...this._tabs.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, t]) => ({ uuid: t.uuid, label: t.label }));
    this._context.workspaceState.update('aiCowork.tabRegistry', registry);
  }

  // ── WebviewViewProvider ───────────────────────────────────────────────────

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _ctx: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri],
    };
    webviewView.webview.html = getWebviewHtml();
    webviewView.webview.onDidReceiveMessage(
      (msg: WebToExt) => this._handleMessage(msg),
      null,
      this._context.subscriptions
    );
  }

  private async _handleMessage(msg: WebToExt) {
    switch (msg.type) {
      case 'ready':
        this._sendApiKeyStatus();
        this._sendIndexStatus();
        this._post({
          type: 'init',
          tabs: [...this._tabs.entries()].map(([id, t]) => ({ tabId: id, label: t.label })),
          activeTabId: this._activeTabId,
        });
        this._post(this._currentEditorCtx);
        break;

      case 'setApiKey':
        await vscode.commands.executeCommand('aiCowork.setApiKey');
        this._sendApiKeyStatus();
        break;

      case 'setMistralApiKey':
        await vscode.commands.executeCommand('aiCowork.setMistralApiKey');
        this._sendApiKeyStatus();
        break;

      case 'setGeminiApiKey':
        await vscode.commands.executeCommand('aiCowork.setGeminiApiKey');
        this._sendApiKeyStatus();
        break;

      case 'setProvider': {
        await vscode.workspace.getConfiguration('aiCowork')
          .update('provider', msg.provider, vscode.ConfigurationTarget.Global);
        this._sendApiKeyStatus();
        break;
      }

      case 'indexWorkspace':
        await this._runIndexing();
        break;

      case 'sendMessage': {
        const tab = this._tabs.get(msg.tabId);
        if (tab) {
          // Rename tab on first message
          if (tab.label.startsWith('Chat ')) {
            const words = msg.text.trim().replace(/\s+/g, ' ').split(' ').slice(0, 5).join(' ');
            tab.label = words.length > 0 ? (words.length > 30 ? words.slice(0, 30) + '…' : words) : tab.label;
            this._post({ type: 'tabRenamed', tabId: msg.tabId, label: tab.label });
            this._saveTabRegistry();
          }
          this._runTurn(msg.text, msg.tabId, msg.context);
        }
        break;
      }

      case 'resolveDroppedFiles': {
        const wsRoot = this._indexer.getRoot() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
        const files: { absPath: string; relPath: string; name: string }[] = [];
        for (const uri of msg.uris) {
          try {
            const fileUri = vscode.Uri.parse(uri);
            if (fileUri.scheme !== 'file') { continue; }
            const absPath = fileUri.fsPath;
            const relPath = wsRoot ? path.relative(wsRoot, absPath) : path.basename(absPath);
            files.push({ absPath, relPath, name: path.basename(absPath) });
          } catch { /* skip invalid URIs */ }
        }
        if (files.length > 0) { this._post({ type: 'resolvedFiles', files }); }
        break;
      }

      case 'clearHistory': {
        const tab = this._tabs.get(msg.tabId);
        if (tab) {
          tab.agent.clearHistory();
          this._post({ type: 'historyCleared', tabId: msg.tabId });
        }
        break;
      }

      case 'createTab': {
        const tabId = this._nextTabId++;
        this._addTab(tabId, randomUUID());
        this._saveTabRegistry();
        const entry = this._tabs.get(tabId)!;
        this._activeTabId = tabId;
        this._post({ type: 'tabCreated', tabId, label: entry.label });
        break;
      }

      case 'closeTab': {
        if (this._tabs.size <= 1) { return; } // never close the last tab
        const allIds = [...this._tabs.keys()].sort((a, b) => a - b);
        const closedIdx = allIds.indexOf(msg.tabId);
        if (closedIdx === -1) { return; }
        const newActiveTabId = closedIdx > 0 ? allIds[closedIdx - 1] : allIds[1];
        this._tabs.get(msg.tabId)?.agent.clearHistory();
        this._tabs.delete(msg.tabId);
        this._saveTabRegistry();
        if (this._activeTabId === msg.tabId) { this._activeTabId = newActiveTabId; }
        this._post({ type: 'tabClosed', tabId: msg.tabId, newActiveTabId });
        break;
      }

      case 'openFile':
        try {
          const uri = vscode.Uri.file(msg.absPath);
          await vscode.window.showTextDocument(uri, { preview: false });
        } catch (e) {
          vscode.window.showErrorMessage(`Cannot open file: ${e}`);
        }
        break;
    }
  }

  private async _runIndexing() {
    this._post({ type: 'indexStatus', status: 'indexing' });
    try {
      await this._indexer.build((done, total) => {
        this._outputChannel.appendLine(`[Index] ${done}/${total}`);
      });
      const count = this._indexer.index?.files.length ?? 0;
      this._post({ type: 'indexStatus', status: 'ready', fileCount: count });
      vscode.window.showInformationMessage(`AI CoWork: Indexed ${count} files ✓`);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this._post({ type: 'indexStatus', status: 'error', error: errMsg });
      vscode.window.showErrorMessage(`AI CoWork indexing failed: ${errMsg}`);
    }
  }

  private async _runTurn(text: string, tabId: number, context?: MessageContext) {
    const tab = this._tabs.get(tabId);
    if (!tab) { return; }
    try {
      const result = await tab.agent.runTurn(text, (stage) => {
        this._post({ type: 'thinking', stage, tabId });
      }, context);
      this._post({ type: 'turnResult', result: tab.agent.serialize(result), tabId });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this._post({ type: 'error', message: errMsg, tabId });
    }
  }

  private _sendApiKeyStatus() {
    const config = vscode.workspace.getConfiguration('aiCowork');
    const provider = (config.get<string>('provider') ?? 'mistral') as 'anthropic' | 'mistral' | 'gemini';
    const key = provider === 'gemini'
      ? (config.get<string>('geminiApiKey') ?? '')
      : provider === 'mistral'
        ? (config.get<string>('mistralApiKey') ?? '')
        : (config.get<string>('apiKey') ?? '');
    const hasMistralKey = (config.get<string>('mistralApiKey') ?? '').length > 0;
    const hasGeminiKey  = (config.get<string>('geminiApiKey')  ?? '').length > 0;
    this._post({ type: 'apiKeyStatus', hasKey: key.length > 0 });
    this._post({ type: 'providerStatus', provider, hasMistralKey, hasGeminiKey });
  }

  private _sendIndexStatus() {
    if (this._indexer.index) {
      this._post({ type: 'indexStatus', status: 'ready', fileCount: this._indexer.index.files.length });
    } else {
      this._post({ type: 'indexStatus', status: 'idle' });
    }
  }

  private _post(msg: ExtToWeb) {
    this._view?.webview.postMessage(msg);
  }

  // ── Public API (called from extension commands) ───────────────────────────

  public triggerIndex() { this._runIndexing(); }

  public notifyApiKeyChanged() { this._sendApiKeyStatus(); }

  public clearActiveTabHistory() {
    const tab = this._tabs.get(this._activeTabId);
    if (tab) {
      tab.agent.clearHistory();
      this._post({ type: 'historyCleared', tabId: this._activeTabId });
    }
  }
}

// ─── Webview HTML ─────────────────────────────────────────────────────────────

function getWebviewHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI CoWork</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap');

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

:root{
  --bg:var(--vscode-sideBar-background,#1e1e1e);
  --surface:var(--vscode-editor-background,#252526);
  --surface2:var(--vscode-input-background,#2d2d2d);
  --surface3:#333748;
  --border:var(--vscode-panel-border,#3c3c3c);
  --border2:#454560;
  --accent:#fbbf24;
  --accent2:#f59e0b;
  --accentGlow:rgba(251,191,36,.18);
  --green:#4ade80;
  --red:#f87171;
  --yellow:#fbbf24;
  --blue:#60a5fa;
  --text:var(--vscode-foreground,#cccccc);
  --text2:var(--vscode-descriptionForeground,#9d9d9d);
  --text3:#5a5a7a;
  --mono:'JetBrains Mono',monospace;
  --sans:'Inter',var(--vscode-font-family,sans-serif);
  --r:8px;
}

html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--text);font-family:var(--sans)}

/* ── LAYOUT ── */
.app{display:flex;flex-direction:column;height:100vh;overflow:hidden}

/* ── TOP BAR ── */
.topbar{
  display:flex;align-items:center;justify-content:space-between;
  padding:10px 12px 8px;
  border-bottom:1px solid var(--border);
  background:var(--surface);
  flex-shrink:0;
  gap:8px;
}
.logo{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;letter-spacing:-.3px}
.logo-icon{
  width:24px;height:24px;border-radius:6px;
  background:linear-gradient(135deg,var(--accent),#a855f7);
  display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:800;color:#fff;font-family:var(--sans);flex-shrink:0;
}
.topbar-actions{display:flex;gap:6px;align-items:center}
.provider-select{
  background:var(--surface2);border:1px solid var(--border2);
  color:var(--text);font-size:10px;font-family:var(--mono);
  padding:3px 6px;border-radius:5px;cursor:pointer;outline:none;
  transition:border-color .15s;
}
.provider-select:focus{border-color:var(--accent)}
.icon-btn{
  background:none;border:none;cursor:pointer;
  color:var(--text2);padding:4px;border-radius:5px;
  font-size:14px;transition:all .15s;line-height:1;
}
.icon-btn:hover{color:var(--text);background:var(--surface2)}

/* ── STATUS BAR ── */
.statusbar{
  display:flex;align-items:center;justify-content:space-between;
  padding:6px 12px;border-bottom:1px solid var(--border);
  background:var(--surface);flex-shrink:0;
  font-size:11px;font-family:var(--mono);gap:8px;
}
.status-pill{
  display:flex;align-items:center;gap:5px;
  padding:3px 8px;border-radius:20px;
  font-size:10px;font-weight:600;letter-spacing:.3px;
}
.status-idle{background:rgba(90,90,122,.2);color:var(--text3)}
.status-indexing{background:rgba(251,191,36,.12);color:var(--yellow);animation:pulse 1.2s ease infinite}
.status-ready{background:rgba(74,222,128,.12);color:var(--green)}
.status-error{background:rgba(248,113,113,.12);color:var(--red)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.status-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0}
.btn-index{
  background:linear-gradient(135deg,var(--accent),#a855f7);
  border:none;color:#fff;padding:4px 10px;
  border-radius:6px;font-size:10px;font-family:var(--mono);
  font-weight:600;cursor:pointer;transition:all .15s;white-space:nowrap;
}
.btn-index:hover{opacity:.85}
.btn-index:disabled{opacity:.4;cursor:not-allowed}

/* ── TAB BAR ── */
.tabbar{
  display:flex;align-items:stretch;
  border-bottom:1px solid var(--border);
  background:var(--surface);
  flex-shrink:0;
  min-height:34px;
  overflow:hidden;
}
.tab-list{
  display:flex;align-items:stretch;
  overflow-x:auto;flex:1;
  scrollbar-width:none;
}
.tab-list::-webkit-scrollbar{display:none}
.tab{
  display:flex;align-items:center;gap:5px;
  padding:0 10px;
  font-size:11px;font-family:var(--mono);
  color:var(--text3);cursor:pointer;
  border-right:1px solid var(--border);
  white-space:nowrap;flex-shrink:0;
  transition:all .15s;
  position:relative;
  user-select:none;
  min-width:80px;
}
.tab:hover:not(.active){color:var(--text2);background:rgba(255,255,255,.03)}
.tab.active{
  color:var(--text);
  background:var(--bg);
  border-bottom:2px solid var(--accent);
}
.tab-label{font-size:11px}
.tab-close{
  display:flex;align-items:center;justify-content:center;
  width:14px;height:14px;border-radius:3px;
  font-size:13px;line-height:1;color:var(--text3);
  transition:all .12s;margin-left:2px;flex-shrink:0;
}
.tab-close:hover{color:var(--red);background:rgba(248,113,113,.18)}
.tab-new{
  display:flex;align-items:center;justify-content:center;
  width:34px;font-size:18px;flex-shrink:0;
  color:var(--text3);cursor:pointer;
  border-left:1px solid var(--border);
  transition:all .15s;
}
.tab-new:hover{color:var(--accent2);background:var(--accentGlow)}

/* ── PANES ── */
.panes{flex:1;overflow:hidden;position:relative}
.pane{
  display:none;height:100%;
  overflow-y:auto;
  padding:12px 10px;
  flex-direction:column;gap:12px;
}
.pane.active{display:flex}
.pane::-webkit-scrollbar{width:5px}
.pane::-webkit-scrollbar-track{background:transparent}
.pane::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px}

/* ── EMPTY STATE ── */
.empty-state{
  flex:1;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:10px;padding:24px 16px;text-align:center;
}
.empty-icon{font-size:32px;opacity:.4}
.empty-title{font-size:13px;font-weight:600;color:var(--text2)}
.empty-steps{display:flex;flex-direction:column;gap:6px;margin-top:4px;text-align:left;width:100%}
.step{
  display:flex;align-items:flex-start;gap:8px;
  font-size:11px;font-family:var(--mono);color:var(--text3);
  padding:6px 10px;background:var(--surface2);
  border-radius:6px;border:1px solid var(--border);
}
.step-n{
  width:18px;height:18px;border-radius:50%;
  background:var(--accentGlow);border:1px solid var(--accent);
  display:flex;align-items:center;justify-content:center;
  font-size:9px;font-weight:700;color:var(--accent2);flex-shrink:0;margin-top:1px;
}

/* ── MESSAGE BUBBLES ── */
.msg{display:flex;flex-direction:column;gap:4px;animation:fadeUp .2s ease}
@keyframes fadeUp{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.msg-user{align-items:flex-end}
.msg-assistant{align-items:flex-start}
.bubble{
  max-width:92%;padding:9px 12px;
  border-radius:var(--r);font-size:12px;line-height:1.65;
  word-break:break-word;
}
.bubble-user{background:var(--accentGlow);border:1px solid rgba(124,106,247,.35);color:var(--text);white-space:pre-wrap}
.bubble-assistant{
  background:var(--surface2);border:1px solid var(--border);
  color:var(--text);font-family:var(--sans);font-size:12px;
  white-space:normal;
}
.bubble-assistant p{margin:0 0 7px}
.bubble-assistant p:last-child{margin-bottom:0}
.bubble-assistant h1,.bubble-assistant h2,.bubble-assistant h3{font-size:13px;font-weight:700;margin:10px 0 4px}
.bubble-assistant h4,.bubble-assistant h5,.bubble-assistant h6{font-size:12px;font-weight:600;margin:8px 0 3px}
.bubble-assistant h1:first-child,.bubble-assistant h2:first-child,.bubble-assistant h3:first-child{margin-top:0}
.bubble-assistant ul,.bubble-assistant ol{margin:4px 0 7px;padding-left:18px}
.bubble-assistant li{margin:3px 0;line-height:1.55}
.bubble-assistant code{background:rgba(0,0,0,.4);padding:1px 5px;border-radius:3px;font-family:var(--mono);font-size:10.5px;color:var(--blue)}
.bubble-assistant pre{background:rgba(0,0,0,.45);padding:9px 11px;border-radius:5px;overflow-x:auto;margin:7px 0;border:1px solid var(--border)}
.bubble-assistant pre code{background:none;padding:0;font-size:10.5px;color:var(--text)}
.bubble-assistant strong{font-weight:700}
.bubble-assistant em{font-style:italic;color:var(--text2)}
.bubble-assistant hr{border:none;border-top:1px solid var(--border);margin:8px 0}
.bubble-assistant a{color:var(--blue);text-decoration:underline;cursor:pointer}

/* ── THINKING ── */
.thinking-card{
  display:flex;align-items:flex-start;gap:10px;
  padding:10px 12px;background:var(--surface2);
  border:1px solid var(--border);border-radius:var(--r);
  font-size:11px;font-family:var(--mono);color:var(--text2);
}
.spinner{
  width:14px;height:14px;border:2px solid var(--border2);
  border-top-color:var(--accent);border-radius:50%;
  animation:spin .7s linear infinite;flex-shrink:0;margin-top:1px;
}
@keyframes spin{to{transform:rotate(360deg)}}
.think-body{flex:1;display:flex;flex-direction:column;gap:3px;min-width:0}
.think-log{display:flex;flex-direction:column;gap:1px;margin-top:5px;padding-top:5px;border-top:1px solid var(--border);max-height:110px;overflow-y:auto}
.think-log:empty{display:none}
.think-log-item{font-size:9.5px;color:var(--text3);line-height:1.5;padding:1px 0}

/* ── FILES READ BADGE ── */
.files-read{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px}
.file-badge{
  display:flex;align-items:center;gap:4px;
  padding:2px 7px;background:rgba(96,165,250,.1);
  border:1px solid rgba(96,165,250,.25);border-radius:20px;
  font-size:10px;font-family:var(--mono);color:var(--blue);
  cursor:pointer;transition:all .15s;
}
.file-badge:hover{background:rgba(96,165,250,.2)}

/* ── EDIT CARDS ── */
.edit-card{
  background:var(--surface2);border:1px solid var(--border);
  border-radius:var(--r);overflow:hidden;margin-top:4px;font-size:11px;
}
.edit-header{
  display:flex;align-items:center;gap:8px;
  padding:7px 10px;background:var(--surface);border-bottom:1px solid var(--border);
}
.edit-icon{font-size:12px;flex-shrink:0}
.edit-filename{
  font-family:var(--mono);font-size:11px;font-weight:600;
  color:var(--text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.edit-stats{display:flex;gap:6px;font-family:var(--mono);font-size:10px}
.stat-a{color:var(--green)}
.stat-r{color:var(--red)}
.new-badge{
  background:rgba(167,139,250,.15);border:1px solid rgba(167,139,250,.3);
  color:var(--accent2);padding:1px 6px;border-radius:4px;
  font-size:9px;font-weight:700;letter-spacing:.3px;
}
.edit-summary{
  padding:6px 10px;font-family:var(--mono);font-size:10px;
  color:var(--text3);border-bottom:1px solid var(--border);
  background:var(--bg);line-height:1.5;
}

/* ── DIFF VIEWER ── */
.diff-toggle{
  width:100%;background:none;border:none;border-top:1px solid var(--border);
  padding:5px 10px;text-align:left;cursor:pointer;
  color:var(--text3);font-size:10px;font-family:var(--mono);
  display:flex;align-items:center;gap:5px;transition:all .15s;
}
.diff-toggle:hover{color:var(--text2);background:var(--surface3)}
.diff-toggle .ti{transition:transform .2s;font-size:8px}
.diff-toggle.open .ti{transform:rotate(90deg)}
.diff-body{
  display:none;overflow-x:auto;max-height:320px;overflow-y:auto;
  background:var(--bg);border-top:1px solid var(--border);
  font-family:var(--mono);font-size:10px;
}
.diff-body.visible{display:block}
.diff-body::-webkit-scrollbar{width:5px;height:5px}
.diff-body::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px}
.hunk{border-bottom:1px solid var(--border)}
.hunk:last-child{border-bottom:none}
.hunk-sep{padding:3px 10px;color:var(--blue);font-size:9.5px;background:rgba(96,165,250,.07);border-bottom:1px solid var(--border);user-select:none;font-family:var(--mono);letter-spacing:.2px}
.dl{display:flex;align-items:baseline;line-height:1.75;min-width:0}
.la{background:rgba(74,222,128,.13);border-left:2px solid var(--green)}
.lr{background:rgba(248,113,113,.13);border-left:2px solid var(--red)}
.lu{border-left:2px solid transparent}
.ln{color:var(--text3);width:28px;min-width:28px;text-align:right;flex-shrink:0;padding:0 4px;user-select:none;font-size:9.5px}
.ln-div{color:var(--border2);flex-shrink:0;padding:0 1px;user-select:none;font-size:9px}
.lp{width:14px;min-width:14px;flex-shrink:0;text-align:center;user-select:none;padding:0 2px}
.la .lp{color:var(--green);font-weight:700}
.lr .lp{color:var(--red);font-weight:700}
.lu .lp{color:var(--text3)}
.lc{white-space:pre;flex:1;overflow:hidden;padding:0 10px 0 2px}
.la .lc{color:var(--green)}
.lr .lc{color:var(--red)}
.lu .lc{color:var(--text2)}
.no-diff{padding:10px;color:var(--text3);font-size:10px}

/* ── THINKING SECTION ── */
.thinking-section{
  padding:8px 10px;font-size:10px;font-family:var(--mono);
  color:var(--text3);line-height:1.6;border-top:1px solid var(--border);
  background:var(--bg);white-space:pre-wrap;word-break:break-word;
}

/* ── INPUT ── */
.input-area{padding:10px;border-top:1px solid var(--border);background:var(--surface);flex-shrink:0}
.input-wrap{
  position:relative;background:var(--surface2);
  border:1px solid var(--border2);border-radius:var(--r);transition:border-color .2s;
}
.input-wrap:focus-within{border-color:var(--accent);box-shadow:0 0 0 2px var(--accentGlow)}
.chat-input{
  width:100%;background:none;border:none;outline:none;
  color:var(--text);font-size:12px;font-family:var(--mono);
  padding:10px 42px 10px 12px;resize:none;min-height:52px;max-height:140px;line-height:1.6;
}
.chat-input::placeholder{color:var(--text3)}
.send-btn{
  position:absolute;right:8px;bottom:8px;width:28px;height:28px;
  background:linear-gradient(135deg,var(--accent),#a855f7);
  border:none;border-radius:6px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  color:#fff;font-size:13px;transition:all .2s;
}
.send-btn:hover{transform:scale(1.05);box-shadow:0 3px 10px rgba(124,106,247,.35)}
.send-btn:disabled{opacity:.35;cursor:not-allowed;transform:none;box-shadow:none}
.input-hint{margin-top:5px;font-size:10px;font-family:var(--mono);color:var(--text3);display:flex;gap:10px;align-items:center}
.input-hint kbd{background:var(--surface3);border:1px solid var(--border2);border-radius:3px;padding:0 3px;font-family:var(--mono);font-size:9px}

/* ── CONTEXT BAR ── */
.context-bar{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;align-items:center;min-height:0}
.context-bar:empty{margin:0}
.ctx-chip{
  display:flex;align-items:center;gap:3px;
  padding:2px 7px;border-radius:20px;
  font-size:10px;font-family:var(--mono);
  max-width:200px;overflow:hidden;
  user-select:none;flex-shrink:0;
}
.ctx-chip-sel{background:rgba(124,106,247,.12);border:1px solid rgba(124,106,247,.3);color:var(--accent2)}
.ctx-chip-pin{background:rgba(96,165,250,.1);border:1px solid rgba(96,165,250,.25);color:var(--blue)}
.ctx-chip-cur{background:rgba(90,90,122,.1);border:1px solid var(--border);color:var(--text3)}
.ctx-chip-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.ctx-chip-rm{
  display:flex;align-items:center;justify-content:center;
  width:14px;height:14px;border-radius:50%;
  font-size:13px;line-height:1;flex-shrink:0;
  opacity:.55;cursor:pointer;transition:opacity .12s;
}
.ctx-chip-rm:hover{opacity:1}
.input-area.drop-over .input-wrap{outline:2px dashed var(--accent);outline-offset:2px;border-radius:var(--r)}
.drop-hint{margin-left:auto;font-size:9px;font-family:var(--mono);color:var(--text3);opacity:.6}

/* ── API KEY WARNING ── */
.apikey-banner{
  margin:10px;padding:10px 12px;
  background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.25);
  border-radius:var(--r);font-size:11px;font-family:var(--mono);
  color:var(--yellow);display:flex;align-items:center;justify-content:space-between;gap:8px;
}
.btn-setkey{
  background:rgba(251,191,36,.2);border:1px solid rgba(251,191,36,.4);
  color:var(--yellow);padding:3px 8px;border-radius:5px;
  font-size:10px;font-family:var(--mono);cursor:pointer;white-space:nowrap;transition:all .15s;
}
.btn-setkey:hover{background:rgba(251,191,36,.3)}

/* ── ERROR ── */
.error-card{
  padding:10px 12px;background:rgba(248,113,113,.08);
  border:1px solid rgba(248,113,113,.25);border-radius:var(--r);
  font-size:11px;font-family:var(--mono);color:var(--red);
  display:flex;gap:8px;animation:fadeUp .2s ease;
}
</style>
</head>
<body>
<div class="app">

  <!-- TOP BAR -->
  <div class="topbar">
    <div class="logo">
      <div class="logo-icon">AI</div>
      CoWork
    </div>
    <div class="topbar-actions">
      <select class="provider-select" id="providerSelect" onchange="setProvider(this.value)" title="AI Provider">
        <option value="mistral">Mistral</option>
        <option value="gemini">Gemini</option>
        <option value="anthropic">Anthropic</option>
      </select>
      <button class="icon-btn" title="Clear conversation" onclick="clearActiveTab()">🗑</button>
      <button class="icon-btn" id="keyBtn" title="Set API Key" onclick="onKeyBtn()">🔑</button>
    </div>
  </div>

  <!-- STATUS BAR -->
  <div class="statusbar">
    <div class="status-pill status-idle" id="statusPill">
      <div class="status-dot"></div>
      <span id="statusText">Not indexed</span>
    </div>
    <button class="btn-index" id="indexBtn" onclick="indexWorkspace()">Index Workspace</button>
  </div>

  <!-- API KEY BANNER -->
  <div class="apikey-banner" id="apikeyBanner" style="display:none">
    <span id="apikeyBannerText">⚠ No API key set</span>
    <button class="btn-setkey" id="apikeyBannerBtn" onclick="onKeyBtn()">Set Key</button>
  </div>

  <!-- TAB BAR -->
  <div class="tabbar">
    <div class="tab-list" id="tabList"></div>
    <div class="tab-new" title="New tab" onclick="createTab()">+</div>
  </div>

  <!-- MESSAGE PANES (one per tab) -->
  <div class="panes" id="panes"></div>

  <!-- INPUT -->
  <div class="input-area" id="inputArea">
    <div class="context-bar" id="contextBar"></div>
    <div class="input-wrap">
      <textarea class="chat-input" id="chatInput"
        placeholder="e.g. Add error handling to async functions, or ask a question..."
        rows="2"></textarea>
      <button class="send-btn" id="sendBtn" onclick="sendMessage()" title="Send (Ctrl+Enter)">▶</button>
    </div>
    <div class="input-hint">
      <span><kbd>Ctrl</kbd><kbd>↵</kbd> send</span>
      <span>Multi-turn · per-tab history</span>
      <span class="drop-hint">📎 drop files here</span>
    </div>
  </div>

</div>

<script>
const vscode = acquireVsCodeApi();
function vsc(msg){ vscode.postMessage(msg); }

// ── State ─────────────────────────────────────────────────────────────────────
let activeTabId = 1;
const tabBusy = {};       // tabId -> boolean
const tabDiffCtr = {};    // tabId -> number  (unique diff element IDs)
const tabStages = {};     // tabId -> string[] (accumulated stage log for current turn)
let currentProvider = 'mistral'; // 'anthropic' | 'mistral'

function setProvider(provider) {
  currentProvider = provider;
  vsc({ type: 'setProvider', provider });
}

function onKeyBtn() {
  if (currentProvider === 'mistral') { vsc({ type: 'setMistralApiKey' }); }
  else if (currentProvider === 'gemini') { vsc({ type: 'setGeminiApiKey' }); }
  else { vsc({ type: 'setApiKey' }); }
}

function nextDiffId(tabId) {
  if (!tabDiffCtr[tabId]) { tabDiffCtr[tabId] = 0; }
  return \`t\${tabId}d\${tabDiffCtr[tabId]++}\`;
}

// ── Context selection state ───────────────────────────────────────────────────
let editorCtx = null;   // { absPath, relPath, startLine, endLine, hasSelection }
let pinnedFiles = [];   // [{ absPath, relPath, name }]

function renderContextBar() {
  const bar = document.getElementById('contextBar');
  bar.innerHTML = '';

  // 1. Selected lines (highest priority)
  if (editorCtx && editorCtx.hasSelection) {
    bar.appendChild(makeCtxChip(
      '📄 ' + shortName(editorCtx.relPath || '') + ' L' + editorCtx.startLine + '–' + editorCtx.endLine,
      'ctx-chip-sel',
      editorCtx.relPath || '',
      () => { editorCtx = editorCtx ? { ...editorCtx, hasSelection: false } : null; renderContextBar(); }
    ));
  }

  // 2. Pinned files
  pinnedFiles.forEach((f, i) => {
    bar.appendChild(makeCtxChip(
      '📎 ' + f.name,
      'ctx-chip-pin',
      f.relPath,
      () => { pinnedFiles.splice(i, 1); renderContextBar(); }
    ));
  });

  // 3. Current active file as passive indicator (lowest priority)
  if (!editorCtx?.hasSelection && pinnedFiles.length === 0 && editorCtx?.relPath) {
    bar.appendChild(makeCtxChip(
      '📄 ' + shortName(editorCtx.relPath),
      'ctx-chip-cur',
      editorCtx.relPath + ' (active file — auto-included)',
      null
    ));
  }
}

function makeCtxChip(label, cls, title, onRemove) {
  const chip = document.createElement('div');
  chip.className = 'ctx-chip ' + cls;
  chip.title = title || '';
  const lbl = document.createElement('span');
  lbl.className = 'ctx-chip-label';
  lbl.textContent = label;
  chip.appendChild(lbl);
  if (onRemove) {
    const rm = document.createElement('span');
    rm.className = 'ctx-chip-rm';
    rm.textContent = '×';
    rm.onclick = e => { e.stopPropagation(); onRemove(); };
    chip.appendChild(rm);
  }
  return chip;
}

// ── Drag-and-drop ─────────────────────────────────────────────────────────────
(function() {
  const inputArea = document.getElementById('inputArea');
  inputArea.addEventListener('dragover', e => {
    if (e.dataTransfer.types.includes('text/uri-list') || e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      inputArea.classList.add('drop-over');
    }
  });
  inputArea.addEventListener('dragleave', e => {
    if (!inputArea.contains(e.relatedTarget)) {
      inputArea.classList.remove('drop-over');
    }
  });
  inputArea.addEventListener('drop', e => {
    e.preventDefault();
    inputArea.classList.remove('drop-over');
    const uriList = e.dataTransfer.getData('text/uri-list');
    if (uriList) {
      const uris = uriList.split(/\\r?\\n/).map(u => u.trim()).filter(u => u && !u.startsWith('#'));
      if (uris.length > 0) { vsc({ type: 'resolveDroppedFiles', uris }); }
    }
  });
})();

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('load', () => vsc({ type: 'ready' }));

document.getElementById('chatInput').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    sendMessage();
  }
});

document.getElementById('chatInput').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 140) + 'px';
});

// ── Tab management ────────────────────────────────────────────────────────────
function createTab() { vsc({ type: 'createTab' }); }

function closeTab(tabId, event) {
  event.stopPropagation();
  vsc({ type: 'closeTab', tabId });
}

function switchTab(tabId) {
  document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const pane = document.getElementById('pane-' + tabId);
  const tab  = document.getElementById('tab-' + tabId);
  if (pane) { pane.classList.add('active'); }
  if (tab)  { tab.classList.add('active');  tab.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  activeTabId = tabId;
  // Reflect busy state of newly active tab in the send button
  const busy = !!tabBusy[tabId];
  document.getElementById('sendBtn').disabled = busy;
  document.getElementById('chatInput').disabled = busy;
}

function createTabDOM(tabId, label, makeActive) {
  // Tab button
  const tabList = document.getElementById('tabList');
  const tab = document.createElement('div');
  tab.className = 'tab' + (makeActive ? ' active' : '');
  tab.id = 'tab-' + tabId;
  tab.onclick = () => switchTab(tabId);
  tab.innerHTML =
    \`<span class="tab-label">\${esc(label)}</span>\` +
    \`<span class="tab-close" onclick="closeTab(\${tabId}, event)">×</span>\`;
  tabList.appendChild(tab);

  // Pane
  const panes = document.getElementById('panes');
  const pane = document.createElement('div');
  pane.className = 'pane' + (makeActive ? ' active' : '');
  pane.id = 'pane-' + tabId;
  pane.appendChild(makeEmptyState(tabId));
  panes.appendChild(pane);
}

function makeEmptyState(tabId) {
  const d = document.createElement('div');
  d.className = 'empty-state';
  d.id = 'empty-' + tabId;
  d.innerHTML = \`
    <div class="empty-icon">⚡</div>
    <div class="empty-title">AI CoWork</div>
    <div class="empty-steps">
      <div class="step"><div class="step-n">1</div><span>Index your workspace (button above)</span></div>
      <div class="step"><div class="step-n">2</div><span>Type a task or ask a question</span></div>
      <div class="step"><div class="step-n">3</div><span>Claude edits files or answers conversationally</span></div>
      <div class="step"><div class="step-n">4</div><span>Review diff — use Ctrl+Z to undo</span></div>
    </div>\`;
  return d;
}

// ── Actions ───────────────────────────────────────────────────────────────────
function indexWorkspace() { vsc({ type: 'indexWorkspace' }); }

function clearActiveTab() { vsc({ type: 'clearHistory', tabId: activeTabId }); }

function sendMessage() {
  if (tabBusy[activeTabId]) { return; }
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) { return; }

  // Build context: selected lines > pinned files > active file (fallback)
  const context = {};
  if (editorCtx && editorCtx.hasSelection && editorCtx.absPath) {
    context.selectedLines = {
      absPath: editorCtx.absPath,
      relPath: editorCtx.relPath,
      startLine: editorCtx.startLine,
      endLine: editorCtx.endLine,
    };
  }
  if (pinnedFiles.length > 0) {
    context.pinnedFiles = pinnedFiles.map(f => f.absPath);
  } else if (!context.selectedLines && editorCtx && editorCtx.absPath) {
    // No explicit selection/pins — use active file as default priority
    context.pinnedFiles = [editorCtx.absPath];
  }

  hideEmpty(activeTabId);
  appendUserMsg(activeTabId, text);
  input.value = '';
  input.style.height = 'auto';
  setTabBusy(activeTabId, true);
  showThinking(activeTabId, 'Analyzing workspace...');
  const ctx = Object.keys(context).length > 0 ? context : undefined;
  vsc({ type: 'sendMessage', text, tabId: activeTabId, context: ctx });
}

// ── Busy state ────────────────────────────────────────────────────────────────
function setTabBusy(tabId, busy) {
  tabBusy[tabId] = busy;
  if (tabId === activeTabId) {
    document.getElementById('sendBtn').disabled = busy;
    document.getElementById('chatInput').disabled = busy;
  }
}

// ── Status bar ────────────────────────────────────────────────────────────────
function setStatus(status, label) {
  const pill = document.getElementById('statusPill');
  const txt  = document.getElementById('statusText');
  const btn  = document.getElementById('indexBtn');
  pill.className = 'status-pill status-' + status;
  txt.textContent = label;
  btn.disabled = status === 'indexing';
  btn.textContent = status === 'indexing' ? 'Indexing...' : (status === 'ready' ? 'Re-index' : 'Index Workspace');
}

// ── Per-tab message helpers ───────────────────────────────────────────────────
function getPane(tabId) { return document.getElementById('pane-' + tabId); }

function scrollBottom(tabId) {
  const p = getPane(tabId);
  if (p) { p.scrollTop = p.scrollHeight; }
}

function hideEmpty(tabId) {
  const e = document.getElementById('empty-' + tabId);
  if (e) { e.style.display = 'none'; }
}

function appendUserMsg(tabId, text) {
  const pane = getPane(tabId);
  if (!pane) { return; }
  const div = document.createElement('div');
  div.className = 'msg msg-user';
  div.innerHTML = \`<div class="bubble bubble-user">\${esc(text)}</div>\`;
  pane.appendChild(div);
  if (tabId === activeTabId) { scrollBottom(tabId); }
}

// ── Thinking indicator (per tab) ──────────────────────────────────────────────
function showThinking(tabId, stage) {
  removeThinking(tabId);
  tabStages[tabId] = [];
  const pane = getPane(tabId);
  if (!pane) { return; }
  const el = document.createElement('div');
  el.className = 'thinking-card';
  el.id = 'thinking-' + tabId;
  el.innerHTML =
    \`<div class="spinner"></div>\` +
    \`<div class="think-body">\` +
    \`<span id="thinkStage-\${tabId}">\${esc(stage)}</span>\` +
    \`<div class="think-log" id="thinkLog-\${tabId}"></div>\` +
    \`</div>\`;
  pane.appendChild(el);
  if (tabId === activeTabId) { scrollBottom(tabId); }
}

function updateThinking(tabId, stage) {
  if (!tabStages[tabId]) { tabStages[tabId] = []; }
  // Move current stage text into the log before replacing it
  const stageEl = document.getElementById('thinkStage-' + tabId);
  if (stageEl && stageEl.textContent) {
    const prev = stageEl.textContent;
    tabStages[tabId].push(prev);
    const log = document.getElementById('thinkLog-' + tabId);
    if (log) {
      const item = document.createElement('div');
      item.className = 'think-log-item';
      item.textContent = prev;
      log.appendChild(item);
    }
  }
  if (stageEl) { stageEl.textContent = stage; }
  if (tabId === activeTabId) { scrollBottom(tabId); }
}

function removeThinking(tabId) {
  // Capture the final current stage into the log before removing the card
  const stageEl = document.getElementById('thinkStage-' + tabId);
  if (stageEl && stageEl.textContent) {
    if (!tabStages[tabId]) { tabStages[tabId] = []; }
    tabStages[tabId].push(stageEl.textContent);
  }
  document.getElementById('thinking-' + tabId)?.remove();
}

// ── Assistant turn rendering ──────────────────────────────────────────────────
function appendAssistantTurn(tabId, result) {
  const pane = getPane(tabId);
  if (!pane) { return; }
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';

  let html = '';

  // Process log — stages accumulated during this turn
  const stages = tabStages[tabId] || [];
  if (stages.length > 0) {
    const logId = nextDiffId(tabId);
    html += \`
      <div class="edit-card" style="margin-bottom:4px">
        <button class="diff-toggle" id="toggle-\${logId}" onclick="toggleEl('\${logId}','toggle-\${logId}')">
          <span class="ti">▶</span> Process log (\${stages.length} step\${stages.length !== 1 ? 's' : ''})
        </button>
        <div class="thinking-section" id="\${logId}" style="display:none">\${stages.map(s => esc(s)).join('\\n')}</div>
      </div>\`;
    tabStages[tabId] = [];
  }

  // Files read badges
  if (result.filesRead && result.filesRead.length > 0) {
    html += '<div class="files-read">';
    result.filesRead.forEach(f => {
      html += \`<div class="file-badge" onclick="openFile('\${escAttr(f.absPath || f.relPath)}')" title="\${esc(f.relPath)}">📄 \${esc(shortName(f.relPath))}</div>\`;
    });
    html += '</div>';
  }

  // Reply bubble — rendered as markdown
  html += \`<div class="bubble bubble-assistant">\${renderMarkdown(result.reply)}</div>\`;

  // Edit cards
  if (result.edits && result.edits.length > 0) {
    result.edits.forEach(e => {
      const id = nextDiffId(tabId);
      const icon = e.isNew ? '✨' : '✏️';
      html += \`
        <div class="edit-card">
          <div class="edit-header">
            <span class="edit-icon">\${icon}</span>
            <span class="edit-filename" title="\${esc(e.relPath)}">\${esc(e.relPath)}</span>
            \${e.isNew ? '<span class="new-badge">NEW</span>' : ''}
            <div class="edit-stats">
              <span class="stat-a">+\${e.addedLines}</span>
              <span class="stat-r">−\${e.removedLines}</span>
            </div>
          </div>
          <div class="edit-summary">\${esc(e.summary)}</div>
          <button class="diff-toggle open" id="toggle-\${id}" onclick="toggleDiff('\${id}')">
            <span class="ti">▶</span> Diff
          </button>
          <div class="diff-body visible" id="\${id}">\${e.diffHtml}</div>
        </div>\`;
    });
  }

  // Reasoning (collapsed)
  if (result.thinking) {
    const thId = nextDiffId(tabId);
    html += \`
      <div class="edit-card" style="margin-top:4px">
        <button class="diff-toggle" id="toggle-\${thId}" onclick="toggleEl('\${thId}','toggle-\${thId}')">
          <span class="ti">▶</span> Claude's reasoning
        </button>
        <div class="thinking-section" id="\${thId}" style="display:none">\${esc(result.thinking)}</div>
      </div>\`;
  }

  wrap.innerHTML = html;
  pane.appendChild(wrap);
  if (tabId === activeTabId) { scrollBottom(tabId); }
}

function appendError(tabId, msg) {
  const pane = getPane(tabId);
  if (!pane) { return; }
  const div = document.createElement('div');
  div.innerHTML = \`<div class="error-card"><span>⚠</span><span>\${esc(msg)}</span></div>\`;
  pane.appendChild(div.firstElementChild);
  if (tabId === activeTabId) { scrollBottom(tabId); }
}

function clearPaneMessages(tabId) {
  tabStages[tabId] = [];
  const pane = getPane(tabId);
  if (!pane) { return; }
  pane.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.id = 'empty-' + tabId;
  empty.innerHTML = \`
    <div class="empty-icon">⚡</div>
    <div class="empty-title">Conversation cleared</div>
    <div class="empty-steps">
      <div class="step"><div class="step-n">→</div><span>Start a new task below</span></div>
    </div>\`;
  pane.appendChild(empty);
}

// ── Toggle helpers ────────────────────────────────────────────────────────────
function toggleDiff(id) {
  const body = document.getElementById(id);
  const btn  = document.getElementById('toggle-' + id);
  const open = body.classList.contains('visible');
  body.classList.toggle('visible', !open);
  btn.classList.toggle('open', !open);
}

function toggleEl(id, btnId) {
  const el  = document.getElementById(id);
  const btn = document.getElementById(btnId);
  const hidden = el.style.display === 'none';
  el.style.display = hidden ? 'block' : 'none';
  btn.classList.toggle('open', hidden);
}

function openFile(path) { vsc({ type: 'openFile', absPath: path }); }

// ── Utility ───────────────────────────────────────────────────────────────────
function esc(s) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(s || ''));
  return d.innerHTML;
}
function escAttr(s) { return (s || '').replace(/'/g, "\\\\'").replace(/"/g, '&quot;'); }

function renderMarkdown(raw) {
  if (!raw) { return ''; }
  const BT = '\`';
  // 1. Protect fenced code blocks (triple-backtick)
  const fenced = [];
  let s = raw.replace(new RegExp(BT+BT+BT+'([\\\\w-]*)\\\\n?([\\\\s\\\\S]*?)'+BT+BT+BT,'g'), (_, lang, code) => {
    const i = fenced.length;
    const ec = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    fenced.push(\`<pre><code class="lang-\${lang||'text'}">\${ec}</code></pre>\`);
    return '\\x02F'+i+'\\x03';
  });
  // 2. Protect inline code (single backtick)
  const inlined = [];
  s = s.replace(new RegExp(BT+'([^'+BT+'\\\\n]+)'+BT,'g'), (_, code) => {
    const i = inlined.length;
    const ec = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    inlined.push(\`<code>\${ec}</code>\`);
    return '\\x02I'+i+'\\x03';
  });
  // 3. Escape remaining HTML
  s = s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  // 4. Headings
  s = s.replace(/^#{6}\\s+(.+)$/gm,'<h6>$1</h6>');
  s = s.replace(/^#{5}\\s+(.+)$/gm,'<h5>$1</h5>');
  s = s.replace(/^#{4}\\s+(.+)$/gm,'<h4>$1</h4>');
  s = s.replace(/^#{3}\\s+(.+)$/gm,'<h3>$1</h3>');
  s = s.replace(/^#{2}\\s+(.+)$/gm,'<h2>$1</h2>');
  s = s.replace(/^#\\s+(.+)$/gm,'<h1>$1</h1>');
  // 5. Horizontal rules
  s = s.replace(/^(?:---+|\\*\\*\\*+)$/gm,'<hr>');
  // 6. Bold + italic
  s = s.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g,'<strong><em>$1</em></strong>');
  s = s.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>');
  s = s.replace(/\\*([^\\n]+?)\\*/g,'<em>$1</em>');
  // 7. Links
  s = s.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,(_, txt, href) => {
    const safe = /^https?:\\/\\//.test(href) ? href : '#';
    return \`<a href="\${safe}" target="_blank">\${txt}</a>\`;
  });
  // 8. Lists
  const lines = s.split('\\n'), out = [];
  let inUl=false, inOl=false;
  for (const line of lines) {
    const ul=line.match(/^[*\\-]\\s+(.+)/), ol=line.match(/^\\d+\\.\\s+(.+)/);
    if (ul) {
      if (inOl){out.push('</ol>');inOl=false;}
      if (!inUl){out.push('<ul>');inUl=true;}
      out.push(\`<li>\${ul[1]}</li>\`);
    } else if (ol) {
      if (inUl){out.push('</ul>');inUl=false;}
      if (!inOl){out.push('<ol>');inOl=true;}
      out.push(\`<li>\${ol[1]}</li>\`);
    } else {
      if (inUl){out.push('</ul>');inUl=false;}
      if (inOl){out.push('</ol>');inOl=false;}
      out.push(line);
    }
  }
  if (inUl){out.push('</ul>');} if (inOl){out.push('</ol>');}
  s = out.join('\\n');
  // 9. Paragraphs
  const blockRe=/^<(?:h[1-6]|ul|ol|li|pre|hr|div)/;
  s = s.split(/\\n\\n+/).map(para => {
    para=para.trim();
    if (!para){return '';}
    if (blockRe.test(para)){return para;}
    return \`<p>\${para.replace(/\\n/g,'<br>')}</p>\`;
  }).join('');
  // 10. Restore placeholders
  fenced.forEach((b,i)=>{s=s.split('\\x02F'+i+'\\x03').join(b);});
  inlined.forEach((b,i)=>{s=s.split('\\x02I'+i+'\\x03').join(b);});
  return s;
}
function shortName(rel) {
  const parts = (rel || '').replace(/\\\\/g, '/').split('/');
  return parts[parts.length - 1] || rel;
}

// ── Extension message handler ─────────────────────────────────────────────────
window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.type) {

    case 'apiKeyStatus':
      document.getElementById('apikeyBanner').style.display = msg.hasKey ? 'none' : 'flex';
      break;

    case 'providerStatus': {
      currentProvider = msg.provider;
      const sel = document.getElementById('providerSelect');
      if (sel) { sel.value = msg.provider; }
      const bannerText = document.getElementById('apikeyBannerText');
      if (bannerText) {
        bannerText.textContent =
          msg.provider === 'mistral' ? '⚠ No Mistral API key set' :
          msg.provider === 'gemini'  ? '⚠ No Gemini API key set'  :
          '⚠ No Anthropic API key set';
      }
      break;
    }

    case 'indexStatus':
      if (msg.status === 'idle')     { setStatus('idle', 'Not indexed'); }
      if (msg.status === 'indexing') { setStatus('indexing', 'Indexing...'); }
      if (msg.status === 'ready')    { setStatus('ready', msg.fileCount + ' files indexed'); }
      if (msg.status === 'error')    { setStatus('error', 'Index error'); }
      break;

    case 'init':
      // Build initial tab DOM from persisted tab list
      msg.tabs.forEach(t => createTabDOM(t.tabId, t.label, t.tabId === msg.activeTabId));
      activeTabId = msg.activeTabId;
      break;

    case 'tabCreated':
      createTabDOM(msg.tabId, msg.label, false);
      switchTab(msg.tabId);
      break;

    case 'tabRenamed': {
      const tabEl = document.querySelector('#tab-' + msg.tabId + ' .tab-label');
      if (tabEl) { tabEl.textContent = msg.label; }
      break;
    }

    case 'tabClosed':
      document.getElementById('tab-'  + msg.tabId)?.remove();
      document.getElementById('pane-' + msg.tabId)?.remove();
      if (activeTabId === msg.tabId) { switchTab(msg.newActiveTabId); }
      break;

    case 'thinking':
      updateThinking(msg.tabId, msg.stage);
      break;

    case 'turnResult':
      removeThinking(msg.tabId);
      setTabBusy(msg.tabId, false);
      hideEmpty(msg.tabId);
      appendAssistantTurn(msg.tabId, msg.result);
      break;

    case 'error':
      removeThinking(msg.tabId);
      setTabBusy(msg.tabId, false);
      appendError(msg.tabId, msg.message);
      break;

    case 'historyCleared':
      clearPaneMessages(msg.tabId);
      break;

    case 'editorContext':
      editorCtx = msg;
      renderContextBar();
      break;

    case 'resolvedFiles':
      msg.files.forEach(f => {
        if (!pinnedFiles.some(p => p.absPath === f.absPath)) {
          pinnedFiles.push(f);
        }
      });
      renderContextBar();
      break;
  }
});
</script>
</body>
</html>`;
}
