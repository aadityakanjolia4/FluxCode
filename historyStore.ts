import * as vscode from 'vscode';
import { Message } from './types';

const HISTORY_KEY = 'aiCowork.conversationHistory';
const MAX_PERSISTED_MESSAGES = 40;

/**
 * Persists conversation history in VS Code's globalState (survives restarts).
 */
export class HistoryStore {
  constructor(private readonly _context: vscode.ExtensionContext) {}

  save(messages: Message[]): void {
    const toSave = messages.slice(-MAX_PERSISTED_MESSAGES);
    this._context.globalState.update(HISTORY_KEY, toSave);
  }

  load(): Message[] {
    const stored = this._context.globalState.get<Message[]>(HISTORY_KEY);
    if (!Array.isArray(stored)) { return []; }
    // Validate shape
    return stored.filter(
      (m): m is Message =>
        typeof m === 'object' &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string'
    );
  }

  clear(): void {
    this._context.globalState.update(HISTORY_KEY, []);
  }
}
