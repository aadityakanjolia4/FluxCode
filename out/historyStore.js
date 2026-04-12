"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HistoryStore = void 0;
const HISTORY_KEY = 'aiCowork.conversationHistory';
const MAX_PERSISTED_MESSAGES = 40;
/**
 * Persists conversation history in VS Code's globalState (survives restarts).
 */
class HistoryStore {
    constructor(_context) {
        this._context = _context;
    }
    save(messages) {
        const toSave = messages.slice(-MAX_PERSISTED_MESSAGES);
        this._context.globalState.update(HISTORY_KEY, toSave);
    }
    load() {
        const stored = this._context.globalState.get(HISTORY_KEY);
        if (!Array.isArray(stored)) {
            return [];
        }
        // Validate shape
        return stored.filter((m) => typeof m === 'object' &&
            (m.role === 'user' || m.role === 'assistant') &&
            typeof m.content === 'string');
    }
    clear() {
        this._context.globalState.update(HISTORY_KEY, []);
    }
}
exports.HistoryStore = HistoryStore;
//# sourceMappingURL=historyStore.js.map