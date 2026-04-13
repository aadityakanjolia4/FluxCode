import * as vscode from 'vscode';
import { Message } from './types';

const MAX_PERSISTED_MESSAGES = 40;

/**
 * Persists conversation history in VS Code's globalState (survives restarts).
 * Each tab gets its own key; tab 1 uses the legacy key for backward-compatibility.
 */
export class HistoryStore {
  private readonly _key: string;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    tabId = 1
  ) {
    this._key = tabId === 1
      ? 'aiCowork.conversationHistory'
      : `aiCowork.conversationHistory.tab${tabId}`;
  }

  save(messages: Message[]): void {
    const toSave = messages.slice(-MAX_PERSISTED_MESSAGES);
    this._context.globalState.update(this._key, toSave);
  }

  load(): Message[] {
    const stored = this._context.globalState.get<Message[]>(this._key);
    if (!Array.isArray(stored)) { return []; }
    return stored.filter(
      (m): m is Message =>
        typeof m === 'object' &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string'
    );
  }

  clear(): void {
    this._context.globalState.update(this._key, []);
  }
}
