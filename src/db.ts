import { getDb } from "../db/connection.js";
import type { Session, EventRow, Memory, Link, SearchResult } from "./types.js";
import { tierInjectionWeight } from "./tier.js";
import type Database from "better-sqlite3";

// Prepared statement cache for hot paths
const stmtCache = new Map<string, Database.Statement>();
let cachedDb: Database.Database | null = null;

function stmt(sql: string): Database.Statement {
  const db = getDb();
  if (db !== cachedDb) {
    // DB connection changed (e.g., test override) — clear stale statements
    stmtCache.clear();
    cachedDb = db;
  }
  if (!stmtCache.has(sql)) stmtCache.set(sql, db.prepare(sql));
  return stmtCache.get(sql)!;
}

// ── Sessions ───────────────────────────────────────────────

export function insertSession(session: Session): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO sessions (id, project_path, start_time, end_time, summary, compiled, event_count)
    VALUES (@id, @project_path, @start_time, @end_time, @summary, @compiled, @event_count)
  `).run({
    id: session.id,
    project_path: session.project_path,
    start_time: session.start_time,
    end_time: session.end_time ?? null,
    summary: session.summary ?? null,
    compiled: session.compiled,
    event_count: session.event_count,
  });
}

export function updateSession(id: string, updates: Partial<Session>): void {
  const db = getDb();
  const fields = Object.keys(updates)
    .map((k) => `${k} = @${k}`)
    .join(", ");
  db.prepare(`UPDATE sessions SET ${fields} WHERE id = @id`).run({ ...updates, id });
}

export function getSession(id: string): Session | undefined {
  return getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Session | undefined;
}

export function getUncompiledSessions(limit = 20): Session[] {
  return getDb()
    .prepare("SELECT * FROM sessions WHERE compiled = 0 ORDER BY start_time LIMIT ?")
    .all(limit) as Session[];
}

export function markSessionCompiled(id: string): void {
  getDb().prepare("UPDATE sessions SET compiled = 1 WHERE id = ?").run(id);
}

// ── Events ─────────────────────────────────────────────────

export function insertEvent(event: EventRow): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO events (session_id, event_type, timestamp, tool_name, input_json, output_json, content, project_path)
    VALUES (@session_id, @event_type, @timestamp, @tool_name, @input_json, @output_json, @content, @project_path)
  `).run({
    session_id: event.session_id,
    event_type: event.event_type,
    timestamp: event.timestamp,
    tool_name: event.tool_name ?? null,
    input_json: event.input_json ?? null,
    output_json: event.output_json ?? null,
    content: event.content ?? null,
    project_path: event.project_path ?? null,
  });
}

export function getEventsBySession(sessionId: string): EventRow[] {
  return stmt("SELECT * FROM events WHERE session_id = ? ORDER BY timestamp").all(sessionId) as EventRow[];
}

// ── Memories ───────────────────────────────────────────────

export function insertMemory(memory: Memory): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO memories (path, title, content, project_path, tier, created_at, updated_at, access_count)
    VALUES (@path, @title, @content, @project_path, @tier, @created_at, @updated_at, @access_count)
  `).run({
    path: memory.path,
    title: memory.title,
    content: memory.content,
    project_path: memory.project_path ?? null,
    tier: memory.tier,
    created_at: memory.created_at,
    updated_at: memory.updated_at,
    access_count: memory.access_count,
  });

  // Sync FTS
  db.prepare("INSERT INTO memory_fts (rowid, title, content) VALUES (?, ?, ?)").run(
    result.lastInsertRowid,
    memory.title,
    memory.content
  );

  return Number(result.lastInsertRowid);
}

export function updateMemory(path: string, updates: Partial<Memory>): void {
  const db = getDb();
  const memory = getMemoryByPath(path);
  if (!memory) return;

  const fields = Object.keys(updates)
    .filter((k) => k !== "id")
    .map((k) => `${k} = @${k}`)
    .join(", ");

  if (fields) {
    db.prepare(`UPDATE memories SET ${fields} WHERE path = @path`).run({ ...updates, path });
  }

  // Sync FTS if title or content changed
  if (updates.title || updates.content) {
    db.prepare("INSERT INTO memory_fts (rowid, title, content) VALUES (?, ?, ?)").run(
      memory.id,
      updates.title ?? memory.title,
      updates.content ?? memory.content
    );
  }
}

export function getMemoryByPath(path: string): Memory | undefined {
  return stmt("SELECT * FROM memories WHERE path = ?").get(path) as Memory | undefined;
}

export function getMostRecentMemory(projectPath?: string): Memory | undefined {
  const db = getDb();
  if (projectPath) {
    return db.prepare(
      "SELECT * FROM memories WHERE project_path = ? OR project_path IS NULL ORDER BY last_accessed DESC NULLS LAST, updated_at DESC LIMIT 1"
    ).get(projectPath) as Memory | undefined;
  }
  return db.prepare(
    "SELECT * FROM memories ORDER BY last_accessed DESC NULLS LAST, updated_at DESC LIMIT 1"
  ).get() as Memory | undefined;
}

export function deleteMemory(path: string): void {
  const db = getDb();
  const memory = getMemoryByPath(path);
  if (memory?.id) {
    db.prepare("DELETE FROM memory_fts WHERE rowid = ?").run(memory.id);
    db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memory.id);
  }
  db.prepare("DELETE FROM memories WHERE path = ?").run(path);
  db.prepare("DELETE FROM links WHERE source_path = ? OR target_path = ?").run(path, path);
}

export function getMemoriesByTier(tier: string): Memory[] {
  return getDb()
    .prepare("SELECT * FROM memories WHERE tier = ? ORDER BY updated_at DESC")
    .all(tier) as Memory[];
}

export function listMemories(projectPath?: string, tier?: string): Memory[] {
  const db = getDb();
  if (projectPath !== undefined && tier) {
    return db.prepare("SELECT * FROM memories WHERE project_path = ? AND tier = ? ORDER BY updated_at DESC")
      .all(projectPath, tier) as Memory[];
  }
  if (projectPath !== undefined) {
    return db.prepare("SELECT * FROM memories WHERE project_path = ? ORDER BY updated_at DESC")
      .all(projectPath) as Memory[];
  }
  if (tier) {
    return db.prepare("SELECT * FROM memories WHERE tier = ? ORDER BY updated_at DESC")
      .all(tier) as Memory[];
  }
  return db.prepare("SELECT * FROM memories ORDER BY updated_at DESC").all() as Memory[];
}

export function incrementAccessCount(path: string): void {
  stmt("UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE path = ?")
    .run(Date.now(), path);
}

export function incrementAccessCounts(paths: string[]): void {
  if (paths.length === 0) return;
  const placeholders = paths.map(() => "?").join(",");
  getDb().prepare(`
    UPDATE memories SET access_count = access_count + 1, last_accessed = ?
    WHERE path IN (${placeholders})
  `).run(Date.now(), ...paths);
}

// ── Embeddings ─────────────────────────────────────────────

export function insertEmbedding(memoryId: number, embedding: Float32Array): void {
  getDb().prepare("INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)")
    .run(BigInt(memoryId), embedding);
}

export function searchSemantic(
  embedding: Float32Array,
  limit = 10
): Array<{ memory_id: number; distance: number }> {
  return stmt(`
    SELECT memory_id, distance
    FROM memory_embeddings
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `).all(embedding, limit) as Array<{ memory_id: number; distance: number }>;
}

// ── FTS5 Search ────────────────────────────────────────────

export function searchKeyword(query: string, limit = 10): Array<{ rowid: number; rank: number }> {
  // Sanitize query for FTS5
  const safeQuery = query
    .replace(/["]/g, "")
    .split(/\s+/)
    .map((w) => `"${w}"`)
    .join(" ");

  return stmt(`
    SELECT rowid, rank
    FROM memory_fts
    WHERE memory_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(safeQuery, limit) as Array<{ rowid: number; rank: number }>;
}

// ── Hybrid Search ──────────────────────────────────────────

export function searchHybrid(
  queryEmbedding: Float32Array,
  queryText: string,
  options: {
    limit?: number;
    projectPath?: string;
    recencyHalfLifeDays?: number;
  } = {}
): SearchResult[] {
  const { limit = 10, projectPath, recencyHalfLifeDays = 30 } = options;
  const now = Date.now();
  const halfLifeMs = recencyHalfLifeDays * 24 * 60 * 60 * 1000;

  // Get semantic results
  const semanticResults = searchSemantic(queryEmbedding, limit * 2);
  const semanticMap = new Map<number, { rank: number; score: number }>();
  semanticResults.forEach((r, i) => {
    semanticMap.set(r.memory_id, { rank: i + 1, score: 1 / (1 + r.distance) });
  });

  // Get keyword results
  const keywordResults = searchKeyword(queryText, limit * 2);
  const keywordMap = new Map<number, { rank: number; score: number }>();
  keywordResults.forEach((r, i) => {
    keywordMap.set(r.rowid, { rank: i + 1, score: 1 / (1 + Math.abs(r.rank)) });
  });

  // Combine with RRF
  const allIds = new Set([...semanticMap.keys(), ...keywordMap.keys()]);
  const rrfScores = new Map<number, number>();
  const k = 60;

  for (const id of allIds) {
    let score = 0;
    if (semanticMap.has(id)) {
      score += 1 / (k + semanticMap.get(id)!.rank);
    }
    if (keywordMap.has(id)) {
      score += 1 / (k + keywordMap.get(id)!.rank);
    }
    rrfScores.set(id, score);
  }

  // Fetch full memories in a single query and apply project/recency re-ranking
  const db = getDb();
  const ids = [...rrfScores.keys()];
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`).all(...ids) as Memory[];
  const memMap = new Map<number, Memory>(rows.map((m) => [m.id, m]));

  const memories: SearchResult[] = [];

  for (const [id, rrfScore] of rrfScores) {
    const mem = memMap.get(id);
    if (!mem) continue;

    // Project weighting
    let projectMultiplier = 1.0;
    if (projectPath !== undefined) {
      if (mem.project_path === projectPath) projectMultiplier = 1.4;
      else if (mem.project_path === null || mem.project_path === undefined) projectMultiplier = 1.15;
      else projectMultiplier = 0.85;
    }

    // Recency scoring
    const ageMs = now - mem.updated_at;
    const recencyMultiplier = Math.pow(0.5, ageMs / halfLifeMs);

    // Tier weighting
    const tierMultiplier = tierInjectionWeight(mem.tier as any);

    const finalScore = rrfScore * projectMultiplier * (1 + recencyMultiplier) * tierMultiplier;

    memories.push({
      path: mem.path,
      title: mem.title,
      content: mem.content,
      project: mem.project_path ?? undefined,
      tier: mem.tier,
      score: finalScore,
    });
  }

  return memories.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── Links ──────────────────────────────────────────────────

export function insertLink(link: Link): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO links (source_path, target_path, link_type, strength, created_at)
    VALUES (@source_path, @target_path, @link_type, @strength, @created_at)
  `).run(link);
}

export function getLinkedMemories(path: string, hops = 1): Array<{ path: string; title: string; link_type: string; strength: number }> {
  const db = getDb();
  const results: Array<{ path: string; title: string; link_type: string; strength: number }> = [];

  // Direct links (1 hop)
  const direct = db.prepare(`
    SELECT l.target_path as path, m.title, l.link_type, l.strength
    FROM links l JOIN memories m ON l.target_path = m.path
    WHERE l.source_path = ?
    UNION
    SELECT l.source_path as path, m.title, l.link_type, l.strength
    FROM links l JOIN memories m ON l.source_path = m.path
    WHERE l.target_path = ?
  `).all(path, path) as Array<{ path: string; title: string; link_type: string; strength: number }>;

  results.push(...direct);

  // 2 hops
  if (hops >= 2) {
    const neighborPaths = direct.map((d) => d.path);
    if (neighborPaths.length > 0) {
      const placeholders = neighborPaths.map(() => "?").join(",");
      const twoHop = db.prepare(`
        SELECT DISTINCT l.target_path as path, m.title, l.link_type, l.strength * 0.5 as strength
        FROM links l JOIN memories m ON l.target_path = m.path
        WHERE l.source_path IN (${placeholders}) AND l.target_path != ?
        UNION
        SELECT DISTINCT l.source_path as path, m.title, l.link_type, l.strength * 0.5 as strength
        FROM links l JOIN memories m ON l.source_path = m.path
        WHERE l.target_path IN (${placeholders}) AND l.source_path != ?
      `).all(...neighborPaths, path, ...neighborPaths, path) as Array<{ path: string; title: string; link_type: string; strength: number }>;
      results.push(...twoHop);
    }
  }

  return results;
}

// ── Watermark ──────────────────────────────────────────────

export function getWatermark(): { last_session_id: string | null; last_timestamp: number; run_count: number } {
  return getDb().prepare("SELECT * FROM compilation_watermark WHERE id = 1").get() as {
    last_session_id: string | null;
    last_timestamp: number;
    run_count: number;
  };
}

export function updateWatermark(sessionId: string, timestamp: number): void {
  getDb().prepare(`
    UPDATE compilation_watermark
    SET last_session_id = ?, last_timestamp = ?, run_count = run_count + 1
    WHERE id = 1
  `).run(sessionId, timestamp);
}
