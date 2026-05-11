import { createHash } from "crypto";
import { getDb } from "../db/connection.js";
import { loadConfig } from "./config.js";
import { initEmbedProvider, getEmbedProvider } from "./embed-providers.js";

function getTextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function getCachedEmbedding(hash: string): Float32Array | undefined {
  const row = getDb().prepare("SELECT embedding FROM embedding_cache WHERE text_hash = ?").get(hash) as
    | { embedding: Buffer }
    | undefined;
  if (row) {
    return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
  }
  return undefined;
}

function setCachedEmbedding(hash: string, embedding: Float32Array): void {
  getDb().prepare("INSERT OR REPLACE INTO embedding_cache (text_hash, embedding, created_at) VALUES (?, ?, ?)").run(
    hash,
    Buffer.from(embedding.buffer),
    Date.now()
  );
}

/**
 * Generate an embedding for the given text.
 * Uses the best available provider (Transformers.js → Ollama → deterministic).
 * Results are cached by content hash.
 */
export async function generateEmbedding(text: string): Promise<Float32Array> {
  const hash = getTextHash(text);
  const cached = getCachedEmbedding(hash);
  if (cached) return cached;

  const provider = getEmbedProvider() || await initEmbedProvider(loadConfig());
  const embedding = await provider.embed(text);

  setCachedEmbedding(hash, embedding);
  return embedding;
}

/**
 * Batch generate embeddings for multiple texts.
 * If using Transformers.js, this batches through the pipeline for efficiency.
 */
export async function generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
  return Promise.all(texts.map((t) => generateEmbedding(t)));
}

/**
 * Update embeddings for all memories that have changed since their last embedding.
 * Uses the embedding_cache (keyed by content hash) to detect staleness without
 * re-invoking the LLM for unchanged content.
 */
export async function syncEmbeddings(): Promise<number> {
  const db = getDb();

  // 1. Memories without any embedding
  const newRows = db.prepare(`
    SELECT m.id, m.path, m.title, m.content
    FROM memories m
    LEFT JOIN memory_embeddings e ON m.id = e.memory_id
    WHERE e.memory_id IS NULL
  `).all() as Array<{ id: number; path: string; title: string; content: string }>;

  // 2. Memories with embeddings — check if content changed (hash miss = stale)
  const existingRows = db.prepare(`
    SELECT m.id, m.path, m.title, m.content
    FROM memories m
    JOIN memory_embeddings e ON m.id = e.memory_id
  `).all() as Array<{ id: number; path: string; title: string; content: string }>;

  const staleRows: typeof existingRows = [];
  for (const row of existingRows) {
    const text = `${row.title}\n${row.content}`;
    const hash = getTextHash(text);
    if (!getCachedEmbedding(hash)) {
      staleRows.push(row);
    }
  }

  const allRows = [...newRows, ...staleRows];
  if (allRows.length === 0) return 0;

  // Ensure provider is initialized
  const provider = getEmbedProvider() || await initEmbedProvider(loadConfig());

  // Batch generate embeddings
  const texts = allRows.map((r) => `${r.title}\n${r.content}`);
  const embeddings = await Promise.all(texts.map((t) => provider.embed(t)));

  // Batch insert/replace in chunks of 100
  const chunkSize = 100;
  for (let i = 0; i < allRows.length; i += chunkSize) {
    const chunk = allRows.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "(?, ?)").join(",");
    const params = chunk.flatMap((row, idx) => [BigInt(row.id), embeddings[i + idx]]);
    db.prepare(`INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding) VALUES ${placeholders}`).run(...params);
  }

  return allRows.length;
}
