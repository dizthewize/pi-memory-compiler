-- Pi-Memory SQLite Schema
-- Single-file database for events, memories, embeddings, and graph links

-- Sessions: one row per Pi session
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    start_time INTEGER NOT NULL,
    end_time INTEGER,
    summary TEXT,
    compiled INTEGER DEFAULT 0,
    event_count INTEGER DEFAULT 0
);

-- Events: raw capture of every tool call, turn, and lifecycle event
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    event_type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    tool_name TEXT,
    input_json TEXT,
    output_json TEXT,
    content TEXT,
    project_path TEXT
);

-- Memories: distilled wiki pages (the canonical knowledge layer)
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    project_path TEXT,
    tier TEXT DEFAULT 'L1',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    access_count INTEGER DEFAULT 0,
    last_accessed INTEGER,
    UNIQUE(path, project_path)
);

-- Virtual table for vector search via sqlite-vec
CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
    memory_id INTEGER PRIMARY KEY,
    embedding FLOAT[384]
);

-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    title, content,
    content='memories',
    content_rowid='id'
);

-- Links: graph edges between memories
CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_path TEXT NOT NULL,
    target_path TEXT NOT NULL,
    link_type TEXT DEFAULT 'reference',
    strength REAL DEFAULT 1.0,
    created_at INTEGER NOT NULL,
    UNIQUE(source_path, target_path)
);

-- Compilation watermark: tracks how far the dream phase has processed
CREATE TABLE IF NOT EXISTS compilation_watermark (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_session_id TEXT,
    last_timestamp INTEGER,
    run_count INTEGER DEFAULT 0
);

-- Embedding cache: deterministic lookup to avoid re-computing embeddings
CREATE TABLE IF NOT EXISTS embedding_cache (
    text_hash TEXT PRIMARY KEY,
    embedding BLOB NOT NULL,
    created_at INTEGER NOT NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_path);
CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_path);
CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_path);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);
CREATE INDEX IF NOT EXISTS idx_memories_access ON memories(last_accessed DESC, updated_at DESC);
