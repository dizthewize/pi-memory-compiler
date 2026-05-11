# Pi-Memory

A **Pi-native unified memory system** that automatically captures every session, compiles it into an Obsidian-compatible markdown wiki, and injects relevant memories back into context at query time.

Built for developers who work with AI coding agents and want their knowledge to compound over time.

---

## What It Does

| Feature | How |
|---|---|
| **Capture** | Hooks intercept every tool call, turn, and lifecycle event |
| **Flush** | Raw sessions are structured into daily logs on exit |
| **Compile** | Parallel LLM subagents distill logs into wiki pages (the "dream phase") |
| **Inject** | Relevant memories are prepended to context before every LLM call |
| **Age** | Old memories auto-compress: L1 → L2 → L3 → Archive |
| **Search** | Hybrid: vector similarity + FTS5 + graph links + recency |
| **Sync** | Git-based cross-device sync (Obsidian Git plugin + auto-push) |
| **Pin** | Say "remember this" — session is prioritized in compilation |

## Demo

```
[You solve a tricky auth bug with Pi]

You: "That worked! remember this"
Pi: 📌 Flagged this session for preservation.

[3 sessions later...]

You: "do you remember how I fixed the auth bug?"
Pi: [surfaces the pinned memory about auth middleware]
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Pi Session                                      │
│  ┌──────────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────────────────┐ │
│  │ session_start│  │tool_call │  │ turn_end │  │ session_shutdown        │ │
│  └──────┬───────┘  └────┬─────┘  └────┬─────┘  └───────────┬─────────────┘ │
│         │               │             │                    │               │
│         ▼               ▼             ▼                    ▼               │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │                     hooks/memory.ts                                 │    │
│  │  • Create session record      • Capture events to SQLite            │    │
│  │  • Inject profile + hot memories                                    │    │
│  │  • Context hook: search + prepend relevant memories                 │    │
│  └────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         ~/.pi-memory/db/memory.db                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐ │
│  │ sessions │  │  events  │  │ memories │  │  links   │  │embeddings    │ │
│  │          │  │          │  │          │  │          │  │(sqlite-vec)  │ │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    ▼                                   ▼
         ┌──────────────────┐              ┌────────────────────┐
         │  scripts/flush.ts│              │ scripts/compile.ts │
         │  Raw → Daily logs│              │  Logs → Wiki pages │
         └──────────────────┘              └─────────┬──────────┘
                                                     │
                    ┌────────────────────────────────┼───────────────┐
                    ▼                                ▼               ▼
         ┌──────────────────┐           ┌──────────────────┐  ┌──────────┐
         │vault/raw-sessions│           │4 parallel LLM    │  │scripts/  │
         │/YYYY-MM-DD/      │           │subagents         │  │lint.ts   │
         └──────────────────┘           │• Concepts        │  │(auto-run) │
                                        │• Entities        │  └──────────┘
                                        │• Decisions       │
                                        │• Profile         │
                                        └──────────────────┘
                                                     │
                                                     ▼
                              ┌──────────────────────────────────────┐
                              │  Your Obsidian Vault                 │
                              │  • global-wiki/  (concepts, entities)│
                              │  • projects/{name}/  (per-project)   │
                              │  • raw-sessions/  (excluded from git)│
                              └──────────────────────────────────────┘
```

---

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/dizthewize/pi-memory-compiler.git ~/.pi-memory
cd ~/.pi-memory
npm install
```

### 2. Configure

Create `~/.pi-memory/config/config.json`:

```json
{
  "vaultPath": "/path/to/your/Obsidian/Vault",
  "embeddingModel": "Xenova/all-MiniLM-L6-v2",
  "injection": {
    "maxMemories": 8,
    "maxTokens": 2000,
    "projectWeight": 0.7,
    "globalWeight": 0.2,
    "otherProjectWeight": 0.1,
    "recencyHalfLifeDays": 30
  },
  "compilation": {
    "autoTrigger": true,
    "autoTriggerAfterSessions": 5,
    "maxSessionsPerCompile": 20,
    "parallelSubagents": 4
  },
  "tiering": {
    "l1Days": 30,
    "l2Days": 90,
    "l3Days": 365
  },
  "compile": { "mode": "parallel" },
  "flush": { "mode": "llm" },
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini"
  },
  "git": {
    "enabled": true,
    "remote": "origin",
    "branch": "main"
  }
}
```

**No API key in config.** Set via environment variables:

```bash
export OPENAI_API_KEY="sk-..."
# or
export OPENCODE_API_KEY="..."
export OLLAMA_API_KEY="..."
```

### 3. Register the Pi Hook

Edit `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/home/YOUR_USERNAME/.pi-memory/hooks/memory.ts"]
}
```

### 4. Initialize the Database

```bash
npx tsx db/init-db.ts
```

### 5. Open Your Vault in Obsidian

Open the folder at `vaultPath` in Obsidian. Recommended plugins:
- **Obsidian Git** — auto-commit/push every 10 min, auto-pull on startup
- **Dataview** — query frontmatter
- **Graph View** — visualize wiki-links

That's it. Use Pi normally. After 5 sessions, compilation triggers automatically.

---

## Pi Slash Commands

| Command | Description |
|---|---|
| `/memory-search <query>` | Hybrid search: vector + FTS + graph + recency |
| `/memory-compile` | Trigger dream phase manually |
| `/memory-lint` | Full health check |
| `/memory-status` | Show capture stats and pending compilations |
| `/memory-benchmark` | Run performance benchmarks |
| `/memory-pin <query>` | Pin a memory to prevent aging |

## Natural Language Pinning

No slash command needed:

| You say | What happens |
|---|---|
| "remember this" | Session flagged for priority compilation |
| "pin this" | Same |
| "do you remember X?" | Hybrid search finds it, injects into context |

---

## How It Works

### Capture → Flush → Compile → Inject

1. **Capture**: `hooks/memory.ts` intercepts Pi events (`tool_call`, `tool_result`, `turn_end`) and stores them in SQLite
2. **Flush**: On `session_shutdown`, raw events are written to daily markdown logs (`raw-sessions/YYYY-MM-DD/`)
3. **Compile**: After 5 sessions, 4 parallel LLM subagents distill logs into wiki pages (concepts, entities, decisions, profile)
4. **Inject**: Before every LLM call, relevant memories are searched and prepended to context

### Embeddings

Three-tier provider chain:
1. **Transformers.js** (`all-MiniLM-L6-v2`, 384d) — local, free, works offline
2. **Ollama** (`nomic-embed-text`) — local fallback
3. **Deterministic fallback** — hash-based pseudo-vectors, zero deps

Embeddings are cached by content hash. Stale embeddings are auto-detected and regenerated.

### Tiered Memory

| Tier | Age | Injection | Content |
|---|---|---|---|
| **L1** | 0–30 days | Always | Full detail |
| **L2** | 31–90 days | If relevance > 0.7 | LLM-summarized |
| **L3** | 91–365 days | If relevance > 0.9 | Compressed to bullets |
| **Archive** | 365+ days | Never | One-paragraph summary |

`pin: true` in frontmatter prevents demotion.

---

## Database Schema

```sql
sessions      → id, project_path, start_time, end_time, summary, compiled, event_count
events        → id, session_id, event_type, timestamp, tool_name, input_json, output_json, content
memories      → id, path, title, content, project_path, tier, created_at, updated_at, access_count
links         → id, source_path, target_path, link_type, strength, created_at
memory_fts    → FTS5 virtual table for full-text search
memory_embeddings → sqlite-vec virtual table for vector search
embedding_cache → text_hash → embedding lookup (avoids re-computation)
```

---

## CLI Scripts

```bash
# Flush uncompiled sessions to daily logs
npx tsx scripts/flush.ts

# Compile logs into wiki
npx tsx scripts/compile.ts [session-limit]

# Health check
npx tsx scripts/lint.ts

# Search
npx tsx scripts/query.ts "your question"

# Benchmarks
npx tsx scripts/benchmark.ts

# Git sync
npx tsx scripts/sync.ts pull
npx tsx scripts/sync.ts push

# Run tests
npm test
```

---

## Security

- `raw-sessions/` is **gitignored** — raw logs never committed
- Redaction patterns strip API keys, tokens, passwords from captured events
- API keys are read from environment variables only — never hardcoded

---

## Vault Structure

```
Your-Obsidian-Vault/
├── .gitignore
├── global-wiki/
│   ├── index.md
│   ├── log.md
│   ├── lint-reports/
│   ├── benchmarks/
│   ├── profile/
│   │   ├── role.md
│   │   ├── preferences.md
│   │   └── patterns.md
│   ├── concepts/
│   ├── entities/
│   ├── decisions/
│   └── errors/
├── projects/
│   └── {project-name}/
│       ├── index.md
│       ├── concepts/
│       ├── entities/
│       └── decisions/
└── raw-sessions/          ← gitignored
    └── YYYY-MM-DD/
        └── {session-id}.md
```

---

## Documentation

- **[AGENTS.md](AGENTS.md)** — Technical reference for AI agents modifying the system
- **[MEMORY_SCHEMA.md](MEMORY_SCHEMA.md)** — Wiki conventions, page templates, frontmatter spec
- **[OPTIMIZATIONS.md](OPTIMIZATIONS.md)** — Performance tuning catalog

---

## License

MIT — see [LICENSE](LICENSE)
