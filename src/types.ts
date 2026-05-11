export interface Session {
  id: string;
  project_path: string;
  start_time: number;
  end_time?: number;
  summary?: string;
  compiled: number;
  event_count: number;
}

export interface EventRow {
  id?: number;
  session_id: string;
  event_type: string;
  timestamp: number;
  tool_name?: string;
  input_json?: string;
  output_json?: string;
  content?: string;
  project_path?: string;
}

export interface Memory {
  id?: number;
  path: string;
  title: string;
  content: string;
  project_path?: string;
  tier: "L1" | "L2" | "L3" | "archive";
  created_at: number;
  updated_at: number;
  access_count: number;
  last_accessed?: number;
}

export interface Link {
  id?: number;
  source_path: string;
  target_path: string;
  link_type: "reference" | "contradiction" | "supersedes" | "related";
  strength: number;
  created_at: number;
}

export interface SearchResult {
  path: string;
  title: string;
  content: string;
  project?: string;
  tier: string;
  score: number;
}

export interface PiMemoryConfig {
  vaultPath: string;
  dbPath: string;
  embeddingModel: string;
  injection: {
    maxMemories: number;
    maxTokens: number;
    projectWeight: number;
    globalWeight: number;
    otherProjectWeight: number;
    recencyHalfLifeDays: number;
  };
  compilation: {
    autoTrigger: boolean;
    autoTriggerAfterSessions: number;
    maxSessionsPerCompile: number;
    parallelSubagents: number;
  };
  tiering: {
    l1Days: number;
    l2Days: number;
    l3Days: number;
  };
  redactionPatterns: string[];
  obsidian: {
    syncOnCompile: boolean;
    wikiLinkFormat: "short" | "absolute";
    autoPushOnCompile?: boolean;
  };
  git?: {
    enabled: boolean;
    remote?: string;
    branch?: string;
  };
  llm?: {
    provider: "openai" | "ollama" | "ollama-cloud" | "opencode-go" | "anthropic" | "custom";
    apiKey?: string;
    model: string;
    baseUrl?: string;
    maxTokens?: number;
    temperature?: number;
  };
  flush: {
    mode: "heuristic" | "llm";
  };
  compile: {
    mode: "heuristic" | "llm" | "parallel";
  };
}
