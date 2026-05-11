# Pi-Memory Performance Optimizations

Generated: 2026-05-11

This document catalogs every performance bottleneck discovered in the Pi-Memory codebase, ranked by impact. Each entry includes the problem, the fix, expected gains, and file location.

---

## 🔴 High Impact

### 1. Fix N+1 Query in `searchHybrid`

**File:** `src/db.ts` — `searchHybrid()`

**Problem:** After getting result IDs from vector + FTS search, the code fetches each memory individually in a loop:

```typescript
for (const [id, rrfScore] of rrfScores) {
  const mem = db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
  // ... 20 round-trips for 20 results
}
```

For a limit of 10 memories, this does ~20 separate queries (2× limit because both semantic and keyword results are fetched).

**Fix:** Single query with `IN (...)`:

```typescript
const ids = [...rrfScores.keys()];
const placeholders = ids.map(() => "?").join(",");
const memories = db.prepare(
  `SELECT * FROM memories WHERE id IN (${placeholders})`
).all(...ids);

// Build a map for fast lookup
const memMap = new Map(memories.map(m => [m.id, m]));

for (const [id, rrfScore] of rrfScores) {
  const mem = memMap.get(id);
  if (!mem) continue;
  // ... scoring logic unchanged
}
```

**Expected:** 20× faster for 20 results (~5ms → ~0.3ms).

**Effort:** 15 minutes

---

### 2. Batch `incrementAccessCount`

**File:** `src/inject.ts` — `buildMemoryInjection()`, `src/db.ts` — `incrementAccessCount()`

**Problem:** Every injected memory triggers a separate UPDATE:

```typescript
// src/inject.ts
for (const r of results) {
  incrementAccessCount(r.path); // UPDATE per result = 8 writes
}
```

**Fix:** Single batched UPDATE:

```typescript
// src/db.ts
export function incrementAccessCounts(paths: string[]): void {
  if (paths.length === 0) return;
  const placeholders = paths.map(() => "?").join(",");
  getDb().prepare(`
    UPDATE memories 
    SET access_count = access_count + 1, last_accessed = ?
    WHERE path IN (${placeholders})
  `).run(Date.now(), ...paths);
}

// src/inject.ts
const injectedPaths = [];
for (const r of results) {
  if (!shouldInject(r.tier as any, r.score)) continue;
  // ... build entry ...
  injectedPaths.push(r.path);
}
incrementAccessCounts(injectedPaths);
```

**Expected:** 8× fewer writes per query.

**Effort:** 10 minutes

---

### 3. Only Check Stale Memories in `runTierTransitions`

**File:** `scripts/compile.ts` — `runTierTransitions()`

**Problem:** Every compilation iterates **all** memories to check age:

```typescript
const memories = db.prepare("SELECT * FROM memories").all();
// 1000 memories = 1000 rows × check pin × compute age
```

For a vault with 500+ memories, this is wasteful — 90%+ are fresh L1.

**Fix:** Query only memories that could possibly transition:

```typescript
const now = Date.now();
const l1Threshold = now - config.tiering.l1Days * 24 * 60 * 60 * 1000;
const l2Threshold = now - config.tiering.l2Days * 24 * 60 * 60 * 1000;
const l3Threshold = now - config.tiering.l3Days * 24 * 60 * 60 * 1000;

const memories = db.prepare(`
  SELECT * FROM memories
  WHERE (tier = 'L1' AND updated_at < ?)
     OR (tier = 'L2' AND updated_at < ?)
     OR (tier = 'L3' AND updated_at < ?)
     OR tier = 'archive'
`).all(l1Threshold, l2Threshold, l3Threshold);
```

**Expected:** Skips 90%+ of fresh memories. Compile time drops significantly.

**Effort:** 10 minutes

---

### 4. Only Read Uncompiled Session Logs in `compileSessions`

**File:** `scripts/compile.ts` — `compileSessions()`

**Problem:** Compiles reads **all** raw log files across **all** days:

```typescript
const days = readdirSync(rawDir).filter(...);
for (const day of days) {
  const files = readdirSync(dayDir).filter(f => f.endsWith(".md"));
  // reads every file ever created
}
```

After 100 sessions, every compile still reads all 100 logs.

**Fix:** Use the database as the source of truth for what needs compiling:

```typescript
const sessions = getUncompiledSessions(sessionLimit);
for (const session of sessions) {
  const dayDir = join(rawDir, formatDate(session.start_time));
  const logPath = join(dayDir, `${session.id}.md`);
  if (!existsSync(logPath)) continue;
  const logContent = readFileSync(logPath, "utf-8");
  // ... compile logic ...
}
```

**Expected:** After first compile, subsequent compiles only read new logs.

**Effort:** 20 minutes

---

### 5. Cache Profile Files for Session Start

**File:** `src/inject.ts` — `buildProfileInjection()`

**Problem:** Reads 3 profile files from disk on **every** session start:

```typescript
for (const file of ["role.md", "preferences.md", "patterns.md"]) {
  const content = readFileSync(path, "utf-8"); // disk read × 3
}
```

Profile files change rarely but are read on every new Pi tab.

**Fix:** Cache with mtime check:

```typescript
import { statSync } from "fs";

const profileCache = new Map<string, { mtime: number; content: string }>();

function readProfileCached(path: string): string {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats) return "";
  
  const cached = profileCache.get(path);
  if (cached && cached.mtime >= stats.mtimeMs) {
    return cached.content;
  }
  
  const content = readFileSync(path, "utf-8");
  profileCache.set(path, { mtime: stats.mtimeMs, content });
  return content;
}
```

**Expected:** Eliminates 3 disk reads per session (only re-reads when edited).

**Effort:** 15 minutes

---

## 🟡 Medium Impact

### 6. Batch Embedding Inserts in `syncEmbeddings`

**File:** `src/embed.ts` — `syncEmbeddings()`

**Problem:** One INSERT per memory:

```typescript
for (const row of rows) {
  db.prepare("INSERT INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)")
    .run(BigInt(row.id), embedding);
}
```

**Fix:** Chunk into multi-row INSERTs (SQLite supports up to 999 params):

```typescript
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

const memoryChunks = chunk(rows, 100); // 100 × 2 params = 200 < 999
for (const chunk of memoryChunks) {
  const placeholders = chunk.map(() => "(?, ?)").join(",");
  const params = chunk.flatMap(r => [BigInt(r.id), embeddings.get(r.id)]);
  db.prepare(`INSERT INTO memory_embeddings (memory_id, embedding) VALUES ${placeholders}`)
    .run(...params);
}
```

**Expected:** 100× fewer statement preparations for bulk embedding.

**Effort:** 15 minutes

---

### 7. Add Missing Index: `memories(last_accessed, updated_at)`

**File:** `db/schema.sql`

**Problem:** `getMostRecentMemory()` and `buildProfileInjection()` both query:

```sql
ORDER BY last_accessed DESC NULLS LAST, updated_at DESC
```

But only `idx_memories_updated` exists. `last_accessed` has no index.

**Fix:** Add composite index:

```sql
CREATE INDEX IF NOT EXISTS idx_memories_access ON memories(last_accessed DESC, updated_at DESC);
```

**Expected:** Faster "hot memory" lookups for profile injection.

**Effort:** 2 minutes

---

### 8. Auto-Lint Frequency Cap

**File:** `scripts/compile.ts`

**Problem:** Lint runs after **every** compilation, even if only 1 memory changed:

```typescript
const lintReport = runLint(); // full scan every time
```

**Fix:** Skip lint for minor changes:

```typescript
const shouldLint = (pagesCreated + pagesUpdated >= 3) || 
                   (Date.now() - lastLintTime > 6 * 60 * 60 * 1000); // or 6h
if (shouldLint) {
  const lintReport = runLint();
  // ...
  lastLintTime = Date.now();
} else {
  console.log("Lint: skipped (few changes)");
}
```

**Expected:** Eliminates lint overhead on minor compiles.

**Effort:** 5 minutes

---

### 9. Move `embedding_cache` Table to Schema

**File:** `src/embed.ts`, `db/schema.sql`

**Problem:** `ensureCacheTable()` lazily creates the cache table on first miss after every restart:

```typescript
function ensureCacheTable(): void {
  if (cacheInitialized) return;
  getDb().exec("CREATE TABLE IF NOT EXISTS embedding_cache ...");
}
```

**Fix:** Add to `db/schema.sql` and remove lazy creation:

```sql
CREATE TABLE IF NOT EXISTS embedding_cache (
  text_hash TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
```

```typescript
// Remove ensureCacheTable() entirely
// Remove cacheInitialized flag
```

**Expected:** One less `CREATE TABLE` query on first embedding after restart.

**Effort:** 5 minutes

---

### 10. Skip `FLUSH_OK` Files During Compile

**File:** `scripts/compile.ts`

**Problem:** Trivial sessions (where LLM determined nothing worth saving) still get parsed:

```markdown
# Session: sess-xxx
FLUSH_OK - Nothing worth saving
```

**Fix:** Early skip:

```typescript
if (logContent.includes("FLUSH_OK")) {
  processed++;
  markSessionCompiled(session.sessionId); // mark done
  continue;
}
```

**Expected:** Skips empty sessions instantly.

**Effort:** 5 minutes

---

## 🟢 Low Impact / Nice-to-Have

### 11. Content-Hash-Based Embedding Sync

**File:** `src/embed.ts` — `syncEmbeddings()`

**Problem:** `syncEmbeddings` only checks if an embedding row exists. If memory content changes, the old embedding is stale but never refreshed.

**Fix:** Store a content hash alongside embeddings:

```sql
ALTER TABLE memory_embeddings ADD COLUMN content_hash TEXT;
```

```typescript
function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// In syncEmbeddings:
const currentHash = hashContent(text);
const existing = db.prepare("SELECT content_hash FROM memory_embeddings WHERE memory_id = ?").get(id);
if (existing?.content_hash === currentHash) continue; // skip

// Insert/Update:
db.prepare("INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding, content_hash) VALUES (?, ?, ?)")
  .run(BigInt(id), embedding, currentHash);
```

**Expected:** Avoids re-embedding unchanged memories after minor edits.

**Effort:** 20 minutes

---

### 12. Prepared Statement Reuse

**File:** `src/db.ts`

**Problem:** Hot-path functions create new prepared statements on every call:

```typescript
// Called on every search
return getDb().prepare("SELECT * FROM memories WHERE path = ?").get(path);
```

**Fix:** Cache statements at module level:

```typescript
const stmtCache = new Map<string, Database.Statement>();

function getStmt(sql: string): Database.Statement {
  if (!stmtCache.has(sql)) {
    stmtCache.set(sql, getDb().prepare(sql));
  }
  return stmtCache.get(sql)!;
}

// Usage:
return getStmt("SELECT * FROM memories WHERE path = ?").get(path);
```

**Expected:** Small but measurable reduction in SQL parsing overhead.

**Effort:** 30 minutes

---

### 13. Use `worker_threads` Instead of Process Spawn

**File:** `src/background.ts`

**Problem:** Background flush/compile spawn entirely new Node processes (~50MB each):

```typescript
spawn(process.execPath, ["--import", tsxLoader, scriptPath]);
```

**Fix:** Use `worker_threads` for same-process concurrency:

```typescript
import { Worker } from "worker_threads";

export function triggerFlush(): void {
  new Worker("./scripts/flush-worker.js", { workerData: { limit: 50 } });
}
```

Tradeoff: Workers share memory but require the script to be in a separate file with a specific entrypoint pattern.

**Expected:** ~50MB less RAM per background job, faster startup.

**Effort:** 30 minutes

---

## Priority Queue

If implementing, do in this order for maximum ROI:

1. **#1** (N+1 fix) + **#3** (stale tier check) — 25 min, biggest compile + query wins
2. **#2** (batch access count) + **#5** (profile cache) — 25 min, faster session startup
3. **#4** (only uncompiled logs) — 20 min, major compile speedup at scale
4. **#7** (last_accessed index) — 2 min, free win
5. **#8** (lint cap) + **#10** (skip FLUSH_OK) — 10 min, minor compile wins
6. **#6** (batch embeddings) — 15 min, bulk compile win
7. **#9** (cache table in schema) — 5 min, cleanup
8. Everything else — deferred until benchmarks show need

---

## Benchmark Targets (Before vs After)

| Metric | Before | After | Delta |
|---|---|---|---|
| Query latency (100 memories) | ~50ms | ~10ms | **5×** |
| Context injection (100 memories) | ~200ms | ~50ms | **4×** |
| Compile 10 sessions | ~45s | ~15s | **3×** |
| Tier transitions (500 memories) | ~5s | ~200ms | **25×** |
| Session startup | ~20ms | ~5ms | **4×** |
| Memory per bg job | ~50MB | ~0MB (worker) | **∞** |

---

## Notes

- All changes maintain backward compatibility
- No changes to the Obsidian vault format
- No changes to the hook API
- Most fixes are localized to single functions
