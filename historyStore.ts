import * as vscode from 'vscode';
import { Message } from './types';

const MAX_PERSISTED_MESSAGES = 40;

/**
 * Persists conversation history in VS Code's globalState (survives restarts).
 * Each tab gets a UUID-keyed slot so history never collides across workspaces.
 */
export class HistoryStore {
  private readonly _key: string;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _tabUuid: string
  ) {
    this._key = `aiCowork.conversationHistory.${_tabUuid}`;
  }

  save(messages: Message[]): void {
    const toSave = messages.slice(-MAX_PERSISTED_MESSAGES).map(m => ({ ...m, tabId: this._tabUuid }));
    this._context.globalState.update(this._key, toSave);
  }

  load(): Message[] {
    const stored = this._context.globalState.get<Message[]>(this._key);
    if (!Array.isArray(stored)) { return []; }
    return stored.filter(
      (m): m is Message =>
        typeof m === 'object' &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        (m.tabId === undefined || m.tabId === this._tabUuid)
    );
  }

  clear(): void {
    this._context.globalState.update(this._key, []);
  }
}
