# AGENTS.md — Technical Reference for AI Agents

This file is designed to be read by AI agents (including Pi itself) when modifying the Pi-Memory system.

## Philosophy

- **Markdown-first, SQLite-indexed**: Markdown files in the vault are the canonical truth. SQLite + sqlite-vec is a derived search index.
- **Deterministic capture**: Every session is captured. No opt-out. Redaction handles sensitive data.
- **Compounding knowledge**: Each compilation makes the system smarter. New info merges with old. Contradictions are flagged.
- **Zero-friction**: The user never thinks about memory. It just works.

## Directory Structure

```
~/.pi-memory/
├── db/
│   ├── schema.sql              -- Canonical schema (source of truth)
│   ├── init-db.ts              -- Schema execution + watermark seed
│   └── connection.ts           -- Singleton DB access, auto-initializes
├── src/
│   ├── types.ts                -- TypeScript interfaces
│   ├── config.ts               -- Config loading with defaults
│   ├── db.ts                   -- All CRUD + search (stmt cache, do NOT add raw SQL elsewhere)
│   ├── embed.ts                -- Embedding generation + sync + staleness detection
│   ├── embed-providers.ts      -- Provider chain: Transformers.js → Ollama → deterministic
│   ├── git.ts                  -- Git pull/push/status for cross-device sync
│   ├── llm.ts                  -- Provider-agnostic LLM client + article parsing
│   ├── inject.ts               -- Context injection builder (profile cache)
│   ├── tier.ts                 -- Tier transitions, compression, pinning
│   ├── redact.ts               -- Secret redaction patterns
│   └── project.ts              -- Project path resolution
├── hooks/
│   └── memory.ts               -- Pi hook module (event handlers + slash commands)
├── scripts/
│   ├── compile-utils.ts        -- Shared compile utilities (breaks circular imports)
│   ├── compile.ts              -- Main dream phase (orchestrates compilation, auto-git-push)
│   ├── compile-parallel.ts     -- 4 parallel LLM subagents
│   ├── flush.ts                -- Raw events → daily logs
│   ├── lint.ts                 -- Health checks (structural + optional LLM)
│   ├── benchmark.ts            -- Performance benchmarks
│   ├── query.ts                -- CLI search tool
│   └── sync.ts                 -- Git sync CLI (pull/push/status)
└── config/
    └── config.json             -- User config (env vars for API keys)
```

## Adding a New Database Table

1. Add `CREATE TABLE` to `db/schema.sql`
2. Add TypeScript interface to `src/types.ts`
3. Add CRUD functions to `src/db.ts`
4. Add initialization to `db/init-db.ts` (or it will auto-run via `connection.ts`)
5. Write tests in `src/db.test.ts`

## Adding a New LLM Provider

1. Add provider name to `PiMemoryConfig['llm']['provider']` union in `src/types.ts`
2. Add base URL resolution in `src/llm.ts` `resolveBaseUrl()`
3. Add env var name to `getApiKey()` in `src/llm.ts`
4. Update README.md provider table

## Adding a New Health Check

1. Add check function to `scripts/lint.ts` following the `checkXxx(db, issues)` pattern
2. Call it from `runLint()`
3. Add test to `scripts/lint.test.ts`
4. Document severity rationale (error vs warn vs info)

## Adding a New Slash Command

1. Add `pi.registerCommand()` to `hooks/memory.ts`
2. Handler receives `(args: string, ctx: any)` — args is a single string, NOT an array
3. Use `ctx.ui?.notify?.(message, severity)` where severity is `"info" | "warn" | "error"`
4. For long-running tasks, import the script module and run it (scripts are designed to be importable)

## Adding a New Tier Transition

1. Modify `getTierRules()` in `src/tier.ts` if thresholds change
2. Modify `applyTierTransition()` if new tier-to-tier logic needed
3. Add compression/summarization prompt function (follow existing pattern: summarizeForL2, compressForL3, archiveContent)
4. Update `shouldInject()` if injection rules change
5. Update `tierInjectionWeight()` if search scoring changes

## Hook Event Order

```
session_start
  ↓
context (fires before EVERY LLM call)
  ↓
tool_call → tool_result (repeated)
  ↓
turn_end (after each conversation turn)
  ↓
session.compacting (emergency flush, fires when context fills)
  ↓
session_shutdown (final flush + compile check)
```

## Natural Language Pinning

The hook detects "remember this", "pin this", "remember that", "remember X" in user text during `turn_end`. When detected:

1. A `pin_request` event is inserted into the events table
2. The session is flagged for priority treatment
3. Flush extracts pin requests into a "📌 Pinned Notes" section
4. Compile prompts treat pinned notes as HIGH PRIORITY
5. Resulting wiki pages have `pin: true` in frontmatter

## Important Invariants

1. **Never commit `raw-sessions/`**: These contain raw tool outputs. Already gitignored.
2. **Never hardcode API keys**: Always read from env vars or config. `src/llm.ts` handles resolution.
3. **Always use `getDb()`**: Never create a new Database instance. It's a singleton.
4. **Always close with `closeDb()`**: In scripts, call `closeDb()` before exit to prevent WAL lock.
5. **FTS5 must stay in sync**: `insertMemory` and `updateMemory` in `src/db.ts` automatically sync FTS5. If you bypass them, sync manually.
6. **Embeddings must stay in sync**: `syncEmbeddings()` in `src/embed.ts` regenerates embeddings for changed memories. Call it after bulk inserts.
7. **Tier transitions are async**: `applyTierTransition` calls LLM. Handle failures gracefully.
8. **Statement cache auto-clears**: `src/db.ts` caches prepared statements. The cache auto-clears when `setDbOverride()` changes the DB connection (test isolation).

## Testing Conventions

- Use `initDatabase(":memory:")` for isolated tests
- Use `setDbOverride(testDb)` to mock the singleton
- Always `closeDb()` in `beforeEach`
- Mock LLM calls with `vi.mock("../src/llm.js", ...)` to avoid real API usage
- E2E tests use `/tmp/` for vault paths to avoid polluting the real vault

## Performance Targets

| Metric | Target | Measured By |
|---|---|---|
| Query latency | < 200ms | `scripts/benchmark.ts` |
| Memory injection | < 500ms | `scripts/benchmark.ts` |
| DB size (100 sessions) | < 50MB | `scripts/benchmark.ts` |
| Lint (100 memories) | < 1000ms | `scripts/benchmark.ts` |
| Compile 10 sessions | < 60s | `scripts/benchmark.ts` |

## Common Pitfalls

- **Circular imports**: `compile.ts` and `compile-parallel.ts` must import shared utilities from `compile-utils.ts`, not from each other.
- **Pi hook loading**: Pi uses jiti, not tsx. Use `.js` extensions in imports. Test with `node --import tsx` for validation.
- **WSL paths**: The vault path `/mnt/c/Users/tez/Pi-Memory/` is correct for WSL2 → Windows Obsidian access.
- **BigInt for sqlite-vec**: Memory IDs must be `BigInt` when passed to `memory_embeddings`.
- **Background processes**: Use `process.execPath` + `--import tsxLoader` not `npx tsx` for detached processes.
