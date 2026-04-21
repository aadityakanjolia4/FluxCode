"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HistoryStore = void 0;
const MAX_PERSISTED_MESSAGES = 40;
/**
 * Persists conversation history in VS Code's globalState (survives restarts).
 * Each tab gets a UUID-keyed slot so history never collides across workspaces.
 */
class HistoryStore {
    constructor(_context, _tabUuid) {
        this._context = _context;
        this._tabUuid = _tabUuid;
        this._key = `aiCowork.conversationHistory.${_tabUuid}`;
    }
    save(messages) {
        const toSave = messages.slice(-MAX_PERSISTED_MESSAGES).map(m => ({ ...m, tabId: this._tabUuid }));
        this._context.globalState.update(this._key, toSave);
    }
    load() {
        const stored = this._context.globalState.get(this._key);
        if (!Array.isArray(stored)) {
            return [];
        }
        return stored.filter((m) => typeof m === 'object' &&
            (m.role === 'user' || m.role === 'assistant') &&
            typeof m.content === 'string' &&
            (m.tabId === undefined || m.tabId === this._tabUuid));
    }
    clear() {
        this._context.globalState.update(this._key, []);
    }
}
exports.HistoryStore = HistoryStore;
//# sourceMappingURL=historyStore.js.map