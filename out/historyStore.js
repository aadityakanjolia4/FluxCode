"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HistoryStore = void 0;
const MAX_PERSISTED_MESSAGES = 40;
/**
 * Persists conversation history in VS Code's globalState (survives restarts).
 * Each tab gets its own key; tab 1 uses the legacy key for backward-compatibility.
 */
class HistoryStore {
    constructor(_context, tabId = 1) {
        this._context = _context;
        this._key = tabId === 1
            ? 'aiCowork.conversationHistory'
            : `aiCowork.conversationHistory.tab${tabId}`;
    }
    save(messages) {
        const toSave = messages.slice(-MAX_PERSISTED_MESSAGES);
        this._context.globalState.update(this._key, toSave);
    }
    load() {
        const stored = this._context.globalState.get(this._key);
        if (!Array.isArray(stored)) {
            return [];
        }
        return stored.filter((m) => typeof m === 'object' &&
            (m.role === 'user' || m.role === 'assistant') &&
            typeof m.content === 'string');
    }
    clear() {
        this._context.globalState.update(this._key, []);
    }
}
exports.HistoryStore = HistoryStore;
//# sourceMappingURL=historyStore.js.map