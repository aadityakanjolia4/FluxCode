# AI CoWork v2

A production-grade VS Code extension — Claude-powered multi-turn chat that auto-selects files, edits them, and shows inline diffs.

## How it works

**Two-phase architecture (like Claude Code):**
1. **File Selection Phase** — Claude receives your full workspace file tree + symbol index, decides which files to read
2. **Edit Phase** — Claude reads those files and generates precise edits

No embeddings required. Edits apply via VS Code's WorkspaceEdit API (full undo support with Ctrl+Z).

## Setup

1. Install from `.vsix`
2. Open the **AI CoWork** sidebar (activity bar icon)
3. Run **AI CoWork: Set API Key** (Ctrl+Shift+P)
4. Click **Index Workspace** in the sidebar
5. Start chatting

## Features

- 🔍 **Auto file selection** — Claude scans your file tree and picks relevant files per prompt
- 🗂 **Respects .gitignore** — node_modules, build dirs, lock files all excluded
- 💬 **Multi-turn conversation** — full history kept across prompts
- ✏️ **Edit + Create files** — Claude can create new files too
- 📊 **Inline diff viewer** — see exactly what changed, collapsible per file
- ↩️ **Full undo** — Ctrl+Z works, changes go through VS Code WorkspaceEdit
- 📁 **Click to open** — click any file badge to jump to it
- 🧠 **Reasoning visible** — Claude's thinking shown in collapsible section

## Keyboard Shortcuts

- `Ctrl+Shift+A` — Focus AI CoWork sidebar
- `Ctrl+Enter` — Send message

## Configuration

| Setting | Default | Description |
|---|---|---|
| `aiCowork.apiKey` | — | Anthropic API Key |
| `aiCowork.model` | `claude-sonnet-4-20250514` | Model ID |
| `aiCowork.maxFilesPerTurn` | `10` | Max files read per prompt |
