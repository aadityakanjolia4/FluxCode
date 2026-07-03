// ─── Workspace Index ─────────────────────────────────────────────────────────

export interface FunctionInfo {
  name: string;
  lineStart: number; // 1-indexed
  lineEnd: number;   // 1-indexed, inclusive
  exported: boolean;
}

export interface ClassInfo {
  name: string;
  lineStart: number;
  lineEnd: number;
  exported: boolean;
  methods: string[];
}

export interface SymbolMetadata {
  functions: FunctionInfo[];
  classes: ClassInfo[];
}

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
  /** Human-readable language name (TypeScript, Python, Go, …) */
  language: string;
  /** File mtime as unix ms */
  modifiedAt: number;
  /** Rich symbol metadata with line numbers */
  symbolMeta: SymbolMetadata;
  /** Domain keywords with effective TF (raw count × source boost). key → tf_effective */
  keywords: Record<string, number>;
  /** Sorted line numbers (1-indexed) where each keyword appears in the file body */
  keywordLines: Record<string, number[]>;
  /** True for files between 500KB–1MB: still indexed but symbolMeta/keywords skipped */
  large: boolean;
  /**
   * Index-time importance score: numExports + numImports + importedByCount.
   * Higher = more central to the codebase. Computed in a post-pass after full indexing.
   */
  baseScore: number;
}

export interface WorkspaceIndex {
  /** Workspace root absolute path */
  root: string;
  /** All indexed files */
  files: FileEntry[];
  /** When this index was built */
  builtAt: number;
}

/**
 * A granular file selection: either a whole file (no line range) or a specific
 * function / class body (lineStart + lineEnd from symbolMeta).
 */
export interface FileSelection {
  relPath: string;
  lineStart?: number;
  lineEnd?: number;
}

// ─── Claude API ──────────────────────────────────────────────────────────────

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  /** Unix timestamp (ms) when this message was sent — used for recency weighting */
  timestamp?: number;
  /** UUID of the tab this message belongs to — used for cross-tab filtering */
  tabId?: string;
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

// ─── Context Selection ────────────────────────────────────────────────────────

export interface MessageContext {
  /** Specific lines the user has selected in the editor */
  selectedLines?: { absPath: string; relPath: string; startLine: number; endLine: number };
  /** Files explicitly pinned by the user (drag-drop or active file fallback) */
  pinnedFiles?: string[]; // abs paths
}

// ─── Webview Messages ────────────────────────────────────────────────────────

export type ExtToWeb =
  | { type: 'indexStatus'; status: 'idle' | 'indexing' | 'ready' | 'error'; fileCount?: number; error?: string }
  | { type: 'apiKeyStatus'; hasKey: boolean }
  | { type: 'providerStatus'; provider: 'anthropic' | 'mistral' | 'gemini'; hasMistralKey: boolean; hasGeminiKey: boolean }
  | { type: 'init'; tabs: { tabId: number; label: string }[]; activeTabId: number }
  | { type: 'thinking'; stage: string; tabId: number }
  | { type: 'turnResult'; result: SerializedTurnResult; tabId: number }
  | { type: 'error'; message: string; tabId: number }
  | { type: 'historyCleared'; tabId: number }
  | { type: 'tabCreated'; tabId: number; label: string }
  | { type: 'tabRenamed'; tabId: number; label: string }
  | { type: 'tabClosed'; tabId: number; newActiveTabId: number }
  | { type: 'editorContext'; absPath?: string; relPath?: string; startLine?: number; endLine?: number; hasSelection: boolean }
  | { type: 'resolvedFiles'; files: { absPath: string; relPath: string; name: string }[] };

export type WebToExt =
  | { type: 'ready' }
  | { type: 'indexWorkspace' }
  | { type: 'sendMessage'; text: string; tabId: number; context?: MessageContext }
  | { type: 'setApiKey' }
  | { type: 'setMistralApiKey' }
  | { type: 'setGeminiApiKey' }
  | { type: 'setProvider'; provider: 'anthropic' | 'mistral' | 'gemini' }
  | { type: 'clearHistory'; tabId: number }
  | { type: 'openFile'; absPath: string }
  | { type: 'createTab' }
  | { type: 'closeTab'; tabId: number }
  | { type: 'resolveDroppedFiles'; uris: string[] };

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
