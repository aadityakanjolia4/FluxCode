// ─── Workspace Index ─────────────────────────────────────────────────────────

export interface FileEntry {
  /** Absolute path */
  absPath: string;
  /** Path relative to workspace root */
  relPath: string;
  /** File extension without dot */
  ext: string;
  /** Approximate line count */
  lines: number;
  /** Top-level symbols extracted (functions, classes, exports) */
  symbols: string[];
  /** File size in bytes */
  size: number;
}

export interface WorkspaceIndex {
  /** Workspace root absolute path */
  root: string;
  /** All indexed files */
  files: FileEntry[];
  /** When this index was built */
  builtAt: number;
}

// ─── Claude API ──────────────────────────────────────────────────────────────

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export interface FileRead {
  relPath: string;
  absPath: string;
  content: string;
}

export interface FileEdit {
  /** relative path — may not exist yet (create) */
  relPath: string;
  absPath: string;
  /** null means create new file */
  originalContent: string | null;
  newContent: string;
  summary: string;
  isNew: boolean;
}

export interface TurnResult {
  /** Files Claude decided to read */
  filesRead: FileRead[];
  /** Edits / creations to apply */
  edits: FileEdit[];
  /** Human-readable reply */
  reply: string;
  /** Internal reasoning shown to user */
  thinking: string;
}

// ─── Webview Messages ────────────────────────────────────────────────────────

export type ExtToWeb =
  | { type: 'indexStatus'; status: 'idle' | 'indexing' | 'ready' | 'error'; fileCount?: number; error?: string }
  | { type: 'thinking'; stage: string }
  | { type: 'turnResult'; result: SerializedTurnResult }
  | { type: 'error'; message: string }
  | { type: 'apiKeyStatus'; hasKey: boolean }
  | { type: 'historyCleared' };

export type WebToExt =
  | { type: 'ready' }
  | { type: 'indexWorkspace' }
  | { type: 'sendMessage'; text: string }
  | { type: 'setApiKey' }
  | { type: 'clearHistory' }
  | { type: 'openFile'; absPath: string };

// Serialized version of TurnResult for webview (diffs pre-computed)
export interface SerializedTurnResult {
  reply: string;
  thinking: string;
  filesRead: { relPath: string; absPath: string }[];
  edits: SerializedEdit[];
}

export interface SerializedEdit {
  relPath: string;
  absPath: string;
  summary: string;
  isNew: boolean;
  diffHtml: string;
  addedLines: number;
  removedLines: number;
}
