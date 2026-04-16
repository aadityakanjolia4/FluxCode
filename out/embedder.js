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
exports.EmbeddingStore = void 0;
exports.isEmbeddable = isEmbeddable;
exports.voyageEmbed = voyageEmbed;
const https = __importStar(require("https"));
const vscode = __importStar(require("vscode"));
/* ============================================================
   CONSTANTS
============================================================ */
const CHUNK_LINES = 80; // lines per chunk
const OVERLAP_LINES = 20; // overlap between consecutive chunks
const VOYAGE_BATCH = 64; // max texts per Voyage API request
const VOYAGE_MODEL = 'voyage-code-3';
// Embed code files only — skip JSON, YAML, markdown, CSS, SQL, etc.
const EMBED_EXTS = new Set([
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
    'py', 'go', 'rs', 'java', 'kt', 'cs',
    'c', 'cpp', 'h', 'hpp',
    'vue', 'svelte', 'astro',
]);
function isEmbeddable(ext) {
    return EMBED_EXTS.has(ext.replace('.', '').toLowerCase());
}
/* ============================================================
   CHUNKING
   Splits file content into overlapping line windows so that
   no logic is split across chunk boundaries.
============================================================ */
function chunkFile(relPath, content) {
    const lines = content.split('\n');
    if (lines.length === 0) {
        return [];
    }
    const chunks = [];
    let start = 0;
    while (start < lines.length) {
        const end = Math.min(start + CHUNK_LINES, lines.length);
        chunks.push({
            relPath,
            startLine: start + 1,
            endLine: end,
            content: lines.slice(start, end).join('\n'),
        });
        if (end === lines.length) {
            break;
        }
        start += CHUNK_LINES - OVERLAP_LINES;
    }
    return chunks;
}
/* ============================================================
   VOYAGE AI  —  HTTPS calls (no SDK, matching codebase style)
============================================================ */
async function voyageEmbed(texts, apiKey) {
    if (texts.length === 0) {
        return [];
    }
    const all = [];
    for (let i = 0; i < texts.length; i += VOYAGE_BATCH) {
        const batch = texts.slice(i, i + VOYAGE_BATCH);
        const vecs = await _voyageBatch(batch, apiKey);
        all.push(...vecs);
    }
    return all;
}
function _voyageBatch(texts, apiKey) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ input: texts, model: VOYAGE_MODEL, input_type: 'document' });
        const req = https.request({
            hostname: 'api.voyageai.com',
            path: '/v1/embeddings',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) {
                        reject(new Error(`Voyage API error: ${JSON.stringify(parsed.error)}`));
                        return;
                    }
                    const sorted = [...parsed.data]
                        .sort((a, b) => a.index - b.index);
                    resolve(sorted.map(d => d.embedding));
                }
                catch (e) {
                    reject(new Error(`Voyage parse error: ${e}`));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}
/* ============================================================
   COSINE SIMILARITY
============================================================ */
function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
}
/* ============================================================
   EMBEDDING STORE
   In-memory vector store with disk persistence.
   Uses a flat array of StoredChunk with soft-delete (_dead flag)
   and lazy compaction to avoid expensive rebuilds on every patch.
============================================================ */
class EmbeddingStore {
    constructor() {
        this._chunks = [];
        this._fileIndex = new Map(); // relPath → indices in _chunks
    }
    get size() {
        return this._chunks.filter(c => !c._dead).length;
    }
    /* ── Build ─────────────────────────────────────────────────────────────── */
    /**
     * Embed all supplied code files from scratch.
     * Called once during full workspace index build.
     * onProgress receives (chunksEmbedded, totalChunks).
     */
    async buildFromFiles(files, apiKey, onProgress) {
        this._chunks = [];
        this._fileIndex.clear();
        // Chunk every file first so we know the total upfront
        const raw = files.flatMap(f => chunkFile(f.relPath, f.content));
        if (raw.length === 0) {
            return;
        }
        for (let i = 0; i < raw.length; i += VOYAGE_BATCH) {
            const batch = raw.slice(i, i + VOYAGE_BATCH);
            const vectors = await voyageEmbed(batch.map(c => c.content), apiKey);
            for (let j = 0; j < batch.length; j++) {
                const idx = this._chunks.length;
                this._chunks.push({ ...batch[j], vector: vectors[j] });
                const arr = this._fileIndex.get(batch[j].relPath) ?? [];
                arr.push(idx);
                this._fileIndex.set(batch[j].relPath, arr);
            }
            onProgress(Math.min(i + VOYAGE_BATCH, raw.length), raw.length);
        }
    }
    /**
     * Re-embed a single file after it has been patched on disk.
     * Old chunks for the file are soft-deleted; new ones are appended.
     */
    async patchFile(relPath, content, apiKey) {
        this._removeFile(relPath);
        const raw = chunkFile(relPath, content);
        if (raw.length === 0) {
            return;
        }
        const vectors = await voyageEmbed(raw.map(c => c.content), apiKey);
        const indices = [];
        for (let i = 0; i < raw.length; i++) {
            indices.push(this._chunks.length);
            this._chunks.push({ ...raw[i], vector: vectors[i] });
        }
        this._fileIndex.set(relPath, indices);
        // Compact when dead chunks accumulate past a threshold
        if (this._chunks.filter(c => c._dead).length > 300) {
            this._compact();
        }
    }
    _removeFile(relPath) {
        for (const idx of (this._fileIndex.get(relPath) ?? [])) {
            this._chunks[idx]._dead = true;
        }
        this._fileIndex.delete(relPath);
    }
    _compact() {
        this._chunks = this._chunks.filter(c => !c._dead);
        this._fileIndex.clear();
        for (let i = 0; i < this._chunks.length; i++) {
            const arr = this._fileIndex.get(this._chunks[i].relPath) ?? [];
            arr.push(i);
            this._fileIndex.set(this._chunks[i].relPath, arr);
        }
    }
    /* ── Search ────────────────────────────────────────────────────────────── */
    _topK(queryVec, k) {
        return this._chunks
            .filter(c => !c._dead)
            .map(c => ({ ...c, score: cosine(queryVec, c.vector) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, k);
    }
    /**
     * Two-hop semantic search optimised for code retrieval.
     *
     * Hop 1 — embed the raw user query → top-8 chunks (broad recall).
     *          Catches the most obviously relevant code.
     *
     * Hop 2 — embed the content of the top-3 hop-1 chunks → top-5 chunks each.
     *          Expands to code that is semantically adjacent to what was found:
     *          callers, related types, sibling utilities, test files, etc.
     *          These chunks may not share vocabulary with the original query.
     *
     * Scores are merged at the file level; hop-2 results count at 0.6× weight
     * (lower confidence — they are one step removed from the query).
     * Returns unique relPaths ranked by combined score.
     */
    async multiHopSearch(query, apiKey) {
        if (this.size === 0) {
            return [];
        }
        // Hop 1
        const [qVec] = await voyageEmbed([query], apiKey);
        const hop1 = this._topK(qVec, 8);
        // Hop 2 — re-embed the content of the top-3 hop-1 results
        const contexts = hop1.slice(0, 3).map(c => c.content);
        const ctxVecs = await voyageEmbed(contexts, apiKey);
        const hop2 = ctxVecs.flatMap(v => this._topK(v, 5));
        // Merge per-file scores
        const scores = new Map();
        const add = (chunks, weight) => {
            for (const c of chunks) {
                scores.set(c.relPath, (scores.get(c.relPath) ?? 0) + c.score * weight);
            }
        };
        add(hop1, 1.0);
        add(hop2, 0.6);
        return [...scores.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([relPath]) => relPath);
    }
    /* ── Persistence ───────────────────────────────────────────────────────── */
    async save(storageUri) {
        this._compact(); // ensure no dead chunks are written
        const file = vscode.Uri.joinPath(storageUri, 'embeddings.json');
        const payload = JSON.stringify({ chunks: this._chunks });
        await vscode.workspace.fs.writeFile(file, Buffer.from(payload, 'utf8'));
    }
    async tryLoad(storageUri) {
        const file = vscode.Uri.joinPath(storageUri, 'embeddings.json');
        try {
            const bytes = await vscode.workspace.fs.readFile(file);
            const data = JSON.parse(Buffer.from(bytes).toString('utf8'));
            this._chunks = data.chunks;
            this._fileIndex.clear();
            for (let i = 0; i < this._chunks.length; i++) {
                const arr = this._fileIndex.get(this._chunks[i].relPath) ?? [];
                arr.push(i);
                this._fileIndex.set(this._chunks[i].relPath, arr);
            }
            return true;
        }
        catch {
            return false;
        }
    }
}
exports.EmbeddingStore = EmbeddingStore;
//# sourceMappingURL=embedder.js.map