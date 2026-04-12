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
exports.CoWorkSidebar = void 0;
const vscode = __importStar(require("vscode"));
class CoWorkSidebar {
    constructor(_context, indexer, agent, outputChannel) {
        this._context = _context;
        this._indexer = indexer;
        this._agent = agent;
        this._outputChannel = outputChannel;
    }
    resolveWebviewView(webviewView, _ctx, _token) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri],
        };
        webviewView.webview.html = getWebviewHtml();
        webviewView.webview.onDidReceiveMessage((msg) => this._handleMessage(msg), null, this._context.subscriptions);
    }
    async _handleMessage(msg) {
        switch (msg.type) {
            case 'ready':
                this._sendApiKeyStatus();
                this._sendIndexStatus();
                break;
            case 'setApiKey':
                await vscode.commands.executeCommand('aiCowork.setApiKey');
                this._sendApiKeyStatus();
                break;
            case 'indexWorkspace':
                await this._runIndexing();
                break;
            case 'sendMessage':
                await this._runTurn(msg.text);
                break;
            case 'clearHistory':
                this._agent.clearHistory();
                this._post({ type: 'historyCleared' });
                break;
            case 'openFile':
                try {
                    const uri = vscode.Uri.file(msg.absPath);
                    await vscode.window.showTextDocument(uri, { preview: false });
                }
                catch (e) {
                    vscode.window.showErrorMessage(`Cannot open file: ${e}`);
                }
                break;
        }
    }
    async _runIndexing() {
        this._post({ type: 'indexStatus', status: 'indexing' });
        try {
            await this._indexer.build((done, total) => {
                // Could send progress but keep it simple
                this._outputChannel.appendLine(`[Index] ${done}/${total}`);
            });
            const count = this._indexer.index?.files.length ?? 0;
            this._post({ type: 'indexStatus', status: 'ready', fileCount: count });
            vscode.window.showInformationMessage(`AI CoWork: Indexed ${count} files ✓`);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this._post({ type: 'indexStatus', status: 'error', error: msg });
            vscode.window.showErrorMessage(`AI CoWork indexing failed: ${msg}`);
        }
    }
    async _runTurn(text) {
        try {
            await this._agent.runTurn(text, (stage) => {
                this._post({ type: 'thinking', stage });
            }).then((result) => {
                const serialized = this._agent.serialize(result);
                this._post({ type: 'turnResult', result: serialized });
            });
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this._post({ type: 'error', message: msg });
        }
    }
    _sendApiKeyStatus() {
        const key = vscode.workspace.getConfiguration('aiCowork').get('apiKey') ?? '';
        this._post({ type: 'apiKeyStatus', hasKey: key.length > 0 });
    }
    _sendIndexStatus() {
        if (this._indexer.index) {
            this._post({ type: 'indexStatus', status: 'ready', fileCount: this._indexer.index.files.length });
        }
        else {
            this._post({ type: 'indexStatus', status: 'idle' });
        }
    }
    _post(msg) {
        this._view?.webview.postMessage(msg);
    }
    /** Called from extension commands to trigger indexing from palette */
    triggerIndex() {
        this._runIndexing();
    }
    notifyApiKeyChanged() {
        this._sendApiKeyStatus();
    }
    notifyHistoryCleared() {
        this._post({ type: 'historyCleared' });
    }
}
exports.CoWorkSidebar = CoWorkSidebar;
CoWorkSidebar.viewId = 'aiCowork.chatView';
// ─── Webview HTML ─────────────────────────────────────────────────────────────
function getWebviewHtml() {
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
  --accent:#7c6af7;
  --accent2:#a78bfa;
  --accentGlow:rgba(124,106,247,.18);
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
.logo{
  display:flex;align-items:center;gap:8px;
  font-size:13px;font-weight:700;letter-spacing:-.3px;
}
.logo-icon{
  width:24px;height:24px;border-radius:6px;
  background:linear-gradient(135deg,var(--accent),#a855f7);
  display:flex;align-items:center;justify-content:center;
  font-size:11px;font-weight:800;color:#fff;font-family:var(--sans);
  flex-shrink:0;
}
.topbar-actions{display:flex;gap:6px;align-items:center}
.icon-btn{
  background:none;border:none;cursor:pointer;
  color:var(--text2);padding:4px;border-radius:5px;
  font-size:14px;transition:all .15s;line-height:1;
}
.icon-btn:hover{color:var(--text);background:var(--surface2)}

/* ── STATUS BAR ── */
.statusbar{
  display:flex;align-items:center;justify-content:space-between;
  padding:6px 12px;
  border-bottom:1px solid var(--border);
  background:var(--surface);
  flex-shrink:0;
  font-size:11px;
  font-family:var(--mono);
  gap:8px;
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

/* ── MESSAGES ── */
.messages{
  flex:1;overflow-y:auto;padding:12px 10px;
  display:flex;flex-direction:column;gap:12px;
}
.messages::-webkit-scrollbar{width:5px}
.messages::-webkit-scrollbar-track{background:transparent}
.messages::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px}

/* ── EMPTY STATE ── */
.empty-state{
  flex:1;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:10px;padding:24px 16px;text-align:center;
}
.empty-icon{font-size:32px;opacity:.4}
.empty-title{font-size:13px;font-weight:600;color:var(--text2)}
.empty-steps{
  display:flex;flex-direction:column;gap:6px;margin-top:4px;
  text-align:left;width:100%;
}
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
  word-break:break-word;white-space:pre-wrap;
}
.bubble-user{
  background:var(--accentGlow);
  border:1px solid rgba(124,106,247,.35);
  color:var(--text);
}
.bubble-assistant{
  background:var(--surface2);
  border:1px solid var(--border);
  color:var(--text);
  font-family:var(--mono);font-size:11px;
}

/* ── THINKING ── */
.thinking-card{
  display:flex;align-items:center;gap:10px;
  padding:10px 12px;background:var(--surface2);
  border:1px solid var(--border);border-radius:var(--r);
  font-size:11px;font-family:var(--mono);color:var(--text2);
}
.spinner{
  width:14px;height:14px;border:2px solid var(--border2);
  border-top-color:var(--accent);border-radius:50%;
  animation:spin .7s linear infinite;flex-shrink:0;
}
@keyframes spin{to{transform:rotate(360deg)}}

/* ── FILES READ BADGE ── */
.files-read{
  display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px;
}
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
  border-radius:var(--r);overflow:hidden;margin-top:4px;
  font-size:11px;
}
.edit-header{
  display:flex;align-items:center;gap:8px;
  padding:7px 10px;background:var(--surface);
  border-bottom:1px solid var(--border);
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
.hunk-sep{
  padding:2px 8px;color:var(--text3);font-size:9px;
  background:var(--surface);border-bottom:1px solid var(--border);
  user-select:none;
}
.dl{display:flex;align-items:baseline;padding:0 8px;gap:6px;line-height:1.7}
.la{background:rgba(74,222,128,.07)}
.lr{background:rgba(248,113,113,.07)}
.ln{color:var(--text3);width:28px;text-align:right;flex-shrink:0;user-select:none}
.lp{width:10px;flex-shrink:0;user-select:none}
.la .lp{color:var(--green)}
.lr .lp{color:var(--red)}
.lc{white-space:pre;color:var(--text2);flex:1;overflow:hidden}
.la .lc{color:var(--green)}
.lr .lc{color:var(--red)}
.no-diff{padding:10px;color:var(--text3);font-size:10px}

/* ── THINKING SECTION ── */
.thinking-section{
  padding:8px 10px;font-size:10px;font-family:var(--mono);
  color:var(--text3);line-height:1.6;
  border-top:1px solid var(--border);
  background:var(--bg);
  white-space:pre-wrap;word-break:break-word;
}
.thinking-label{
  font-size:9px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;
  color:var(--text3);margin-bottom:4px;
}

/* ── INPUT ── */
.input-area{
  padding:10px;border-top:1px solid var(--border);
  background:var(--surface);flex-shrink:0;
}
.input-wrap{
  position:relative;background:var(--surface2);
  border:1px solid var(--border2);border-radius:var(--r);
  transition:border-color .2s;
}
.input-wrap:focus-within{
  border-color:var(--accent);
  box-shadow:0 0 0 2px var(--accentGlow);
}
.chat-input{
  width:100%;background:none;border:none;outline:none;
  color:var(--text);font-size:12px;font-family:var(--mono);
  padding:10px 42px 10px 12px;resize:none;
  min-height:52px;max-height:140px;line-height:1.6;
}
.chat-input::placeholder{color:var(--text3)}
.send-btn{
  position:absolute;right:8px;bottom:8px;
  width:28px;height:28px;
  background:linear-gradient(135deg,var(--accent),#a855f7);
  border:none;border-radius:6px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  color:#fff;font-size:13px;transition:all .2s;
}
.send-btn:hover{transform:scale(1.05);box-shadow:0 3px 10px rgba(124,106,247,.35)}
.send-btn:disabled{opacity:.35;cursor:not-allowed;transform:none;box-shadow:none}
.input-hint{
  margin-top:5px;font-size:10px;font-family:var(--mono);
  color:var(--text3);display:flex;gap:10px;
}
.input-hint kbd{
  background:var(--surface3);border:1px solid var(--border2);
  border-radius:3px;padding:0 3px;font-family:var(--mono);font-size:9px;
}

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
  font-size:10px;font-family:var(--mono);cursor:pointer;
  white-space:nowrap;transition:all .15s;
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
      <button class="icon-btn" title="Clear conversation" onclick="clearHistory()">🗑</button>
      <button class="icon-btn" title="Set API Key" onclick="vsc({type:'setApiKey'})">🔑</button>
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

  <!-- API KEY BANNER (hidden by default) -->
  <div class="apikey-banner" id="apikeyBanner" style="display:none">
    ⚠ No API key set
    <button class="btn-setkey" onclick="vsc({type:'setApiKey'})">Set Key</button>
  </div>

  <!-- MESSAGES -->
  <div class="messages" id="messages">
    <div class="empty-state" id="emptyState">
      <div class="empty-icon">⚡</div>
      <div class="empty-title">AI CoWork</div>
      <div class="empty-steps">
        <div class="step"><div class="step-n">1</div><span>Index your workspace (button above)</span></div>
        <div class="step"><div class="step-n">2</div><span>Type a task in natural language</span></div>
        <div class="step"><div class="step-n">3</div><span>Claude auto-selects &amp; edits files</span></div>
        <div class="step"><div class="step-n">4</div><span>Review diff — use Ctrl+Z to undo</span></div>
      </div>
    </div>
  </div>

  <!-- INPUT -->
  <div class="input-area">
    <div class="input-wrap">
      <textarea class="chat-input" id="chatInput"
        placeholder="e.g. Add error handling to all async functions..."
        rows="2"></textarea>
      <button class="send-btn" id="sendBtn" onclick="sendMessage()" title="Send (Ctrl+Enter)">▶</button>
    </div>
    <div class="input-hint">
      <span><kbd>Ctrl</kbd><kbd>↵</kbd> send</span>
      <span>Multi-turn conversation</span>
    </div>
  </div>

</div>

<script>
const vscode = acquireVsCodeApi();
function vsc(msg){ vscode.postMessage(msg); }

let busy = false;
let diffCounter = 0;

// ── Init ─────────────────────────────────────────────────────
window.addEventListener('load', () => vsc({type:'ready'}));

document.getElementById('chatInput').addEventListener('keydown', e => {
  if((e.ctrlKey||e.metaKey) && e.key==='Enter'){
    e.preventDefault();
    sendMessage();
  }
});

document.getElementById('chatInput').addEventListener('input', function(){
  this.style.height='auto';
  this.style.height=Math.min(this.scrollHeight,140)+'px';
});

// ── Actions ──────────────────────────────────────────────────
function indexWorkspace(){
  vsc({type:'indexWorkspace'});
}

function clearHistory(){
  vsc({type:'clearHistory'});
}

function sendMessage(){
  if(busy) return;
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if(!text) return;

  hideEmpty();
  appendUserMsg(text);
  input.value='';
  input.style.height='auto';
  setBusy(true);
  showThinking('Analyzing workspace...');
  vsc({type:'sendMessage', text});
}

// ── Status ───────────────────────────────────────────────────
function setStatus(status, label){
  const pill = document.getElementById('statusPill');
  const txt = document.getElementById('statusText');
  const btn = document.getElementById('indexBtn');
  pill.className = 'status-pill status-'+status;
  txt.textContent = label;
  btn.disabled = status==='indexing';
  btn.textContent = status==='indexing' ? 'Indexing...' : (status==='ready' ? 'Re-index' : 'Index Workspace');
}

// ── Message rendering ─────────────────────────────────────────
function hideEmpty(){
  const e = document.getElementById('emptyState');
  if(e) e.style.display='none';
}

function appendUserMsg(text){
  const msgs = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg msg-user';
  div.innerHTML = \`<div class="bubble bubble-user">\${esc(text)}</div>\`;
  msgs.appendChild(div);
  scrollBottom();
}

let thinkingEl = null;
function showThinking(stage){
  removeThinking();
  const msgs = document.getElementById('messages');
  thinkingEl = document.createElement('div');
  thinkingEl.className = 'thinking-card';
  thinkingEl.id = 'thinkingCard';
  thinkingEl.innerHTML = \`<div class="spinner"></div><span id="thinkStage">\${esc(stage)}</span>\`;
  msgs.appendChild(thinkingEl);
  scrollBottom();
}
function updateThinking(stage){
  const el = document.getElementById('thinkStage');
  if(el) el.textContent = stage;
}
function removeThinking(){
  const el = document.getElementById('thinkingCard');
  if(el) el.remove();
  thinkingEl = null;
}

function appendAssistantTurn(result){
  const msgs = document.getElementById('messages');
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';

  // Files read badges
  let html = '';
  if(result.filesRead && result.filesRead.length > 0){
    html += '<div class="files-read">';
    result.filesRead.forEach(f => {
      html += \`<div class="file-badge" onclick="openFile('\${escAttr(f.absPath||f.relPath)}')" title="\${esc(f.relPath)}">📄 \${esc(shortName(f.relPath))}</div>\`;
    });
    html += '</div>';
  }

  // Reply bubble
  html += \`<div class="bubble bubble-assistant">\${esc(result.reply)}</div>\`;

  // Edit cards
  if(result.edits && result.edits.length > 0){
    result.edits.forEach(e => {
      const id = 'diff-'+(diffCounter++);
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
          <div class="diff-body visible" id="\${id}">
            \${e.diffHtml}
          </div>
        </div>
      \`;
    });
  }

  // Thinking section (collapsed)
  if(result.thinking){
    html += \`
      <div class="edit-card" style="margin-top:4px">
        <button class="diff-toggle" id="toggle-th-\${diffCounter}" onclick="toggleEl('th-\${diffCounter}','toggle-th-\${diffCounter}')">
          <span class="ti">▶</span> Claude's reasoning
        </button>
        <div class="thinking-section" id="th-\${diffCounter}" style="display:none">\${esc(result.thinking)}</div>
      </div>
    \`;
    diffCounter++;
  }

  wrap.innerHTML = html;
  msgs.appendChild(wrap);
  scrollBottom();
}

function appendError(msg){
  const msgs = document.getElementById('messages');
  const div = document.createElement('div');
  div.innerHTML = \`<div class="error-card"><span>⚠</span><span>\${esc(msg)}</span></div>\`;
  msgs.appendChild(div.firstElementChild);
  scrollBottom();
}

function toggleDiff(id){
  const body = document.getElementById(id);
  const btn = document.getElementById('toggle-'+id);
  const isOpen = body.classList.contains('visible');
  body.classList.toggle('visible', !isOpen);
  btn.classList.toggle('open', !isOpen);
}
function toggleEl(id, btnId){
  const el = document.getElementById(id);
  const btn = document.getElementById(btnId);
  const isHidden = el.style.display==='none';
  el.style.display = isHidden ? 'block' : 'none';
  btn.classList.toggle('open', isHidden);
}

function openFile(path){
  vsc({type:'openFile', absPath:path});
}

function setBusy(b){
  busy=b;
  document.getElementById('sendBtn').disabled=b;
  document.getElementById('chatInput').disabled=b;
}

function scrollBottom(){
  const msgs=document.getElementById('messages');
  msgs.scrollTop=msgs.scrollHeight;
}

function esc(s){
  const d=document.createElement('div');
  d.appendChild(document.createTextNode(s||''));
  return d.innerHTML;
}
function escAttr(s){ return (s||'').replace(/'/g,"\\\\'").replace(/"/g,'&quot;'); }
function shortName(relPath){
  const parts=(relPath||'').replace(/\\\\/g,'/').split('/');
  return parts[parts.length-1]||relPath;
}

// ── Message Handler ───────────────────────────────────────────
window.addEventListener('message', e => {
  const msg = e.data;
  switch(msg.type){

    case 'apiKeyStatus':
      document.getElementById('apikeyBanner').style.display = msg.hasKey ? 'none' : 'flex';
      break;

    case 'indexStatus':
      if(msg.status==='idle')     setStatus('idle','Not indexed');
      if(msg.status==='indexing') setStatus('indexing','Indexing...');
      if(msg.status==='ready')    setStatus('ready',msg.fileCount+' files indexed');
      if(msg.status==='error')    setStatus('error','Index error');
      break;

    case 'thinking':
      updateThinking(msg.stage);
      break;

    case 'turnResult':
      removeThinking();
      setBusy(false);
      hideEmpty();
      appendAssistantTurn(msg.result);
      break;

    case 'error':
      removeThinking();
      setBusy(false);
      appendError(msg.message);
      break;

    case 'historyCleared':
      document.getElementById('messages').innerHTML = '';
      const emptyDiv = document.createElement('div');
      emptyDiv.className='empty-state';emptyDiv.id='emptyState';
      emptyDiv.innerHTML=\`<div class="empty-icon">⚡</div>
        <div class="empty-title">Conversation cleared</div>
        <div class="empty-steps">
          <div class="step"><div class="step-n">→</div><span>Start a new task below</span></div>
        </div>\`;
      document.getElementById('messages').appendChild(emptyDiv);
      break;
  }
});
</script>
</body>
</html>`;
}
//# sourceMappingURL=sidebar.js.map