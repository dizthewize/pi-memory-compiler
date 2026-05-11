import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { PiMemoryConfig } from "./types.js";

const DEFAULT_CONFIG: PiMemoryConfig = {
  vaultPath: "/mnt/c/Users/tez/Pi-Memory",
  dbPath: join(homedir(), ".pi-memory", "db", "memory.db"),
  embeddingModel: "Xenova/all-MiniLM-L6-v2",
  injection: {
    maxMemories: 8,
    maxTokens: 2000,
    projectWeight: 0.7,
    globalWeight: 0.2,
    otherProjectWeight: 0.1,
    recencyHalfLifeDays: 30,
  },
  compilation: {
    autoTrigger: true,
    autoTriggerAfterSessions: 5,
    maxSessionsPerCompile: 20,
    parallelSubagents: 4,
  },
  tiering: {
    l1Days: 30,
    l2Days: 90,
    l3Days: 365,
  },
  redactionPatterns: [
    "API_KEY=\\S+",
    "token[=:]\\S+",
    "password[=:]\\S+",
    "secret[=:]\\S+",
  ],
  obsidian: {
    syncOnCompile: true,
    wikiLinkFormat: "short",
    autoPushOnCompile: true,
  },
  git: {
    enabled: true,
    remote: "origin",
    branch: "main",
  },
  flush: {
    mode: "llm",
  },
  compile: {
    mode: "parallel",
  },
};

export function loadConfig(): PiMemoryConfig {
  const configPath = process.env.PI_MEMORY_CONFIG || join(homedir(), ".pi-memory", "config", "config.json");
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const user = JSON.parse(raw) as Partial<PiMemoryConfig>;
      return { ...DEFAULT_CONFIG, ...user };
    } catch {
      // fall through to default
    }
  }
  return DEFAULT_CONFIG;
}

export function getVaultPath(config?: PiMemoryConfig): string {
  const cfg = config || loadConfig();
  return cfg.vaultPath;
}

export function getDbPath(config?: PiMemoryConfig): string {
  const cfg = config || loadConfig();
  return cfg.dbPath;
}
