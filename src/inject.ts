import { getDb } from "../db/connection.js";
import { searchHybrid, incrementAccessCounts } from "./db.js";
import { generateEmbedding } from "./embed.js";
import { loadConfig } from "./config.js";
import { shouldInject } from "./tier.js";
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

export interface InjectedMemory {
  path: string;
  title: string;
  content: string;
  project?: string;
}

/**
 * Build the memory injection block for a given user prompt.
 * Returns a string to prepend to the conversation context.
 */
export async function buildMemoryInjection(
  query: string,
  projectPath: string
): Promise<string> {
  const config = loadConfig();
  const embedding = await generateEmbedding(query);

  const results = searchHybrid(embedding, query, {
    limit: config.injection.maxMemories,
    projectPath,
    recencyHalfLifeDays: config.injection.recencyHalfLifeDays,
  });

  if (results.length === 0) return "";

  const lines: string[] = [];
  lines.push("---");
  lines.push("Relevant memories for this query:");
  lines.push("");

  let tokens = 0;
  const maxTokens = config.injection.maxTokens;

  const injectedPaths: string[] = [];

  for (const r of results) {
    // Skip archive entirely; L2/L3 only if relevance is high enough
    if (!shouldInject(r.tier as any, r.score)) continue;

    const entry = `• [[${r.title}]] (${r.project ?? "global"}): ${r.content.slice(0, 300)}${r.content.length > 300 ? "..." : ""}`;
    const entryTokens = entry.length / 4; // rough estimate

    if (tokens + entryTokens > maxTokens) break;

    lines.push(entry);
    tokens += entryTokens;

    injectedPaths.push(r.path);
  }

  // Batch track access
  incrementAccessCounts(injectedPaths);

  lines.push("---");
  return lines.join("\n");
}

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

/**
 * Load the global profile and project index for session start injection.
 */
export function buildProfileInjection(projectPath: string): string {
  const config = loadConfig();
  const lines: string[] = [];

  // Global profile
  const profileDir = join(config.vaultPath, "global-wiki", "profile");
  const profileFiles = ["role.md", "preferences.md", "patterns.md"];
  for (const file of profileFiles) {
    const path = join(profileDir, file);
    if (existsSync(path)) {
      const content = readProfileCached(path);
      lines.push(`## Profile: ${file.replace(".md", "")}`);
      lines.push(content.slice(0, 1000));
      lines.push("");
    }
  }

  // Project index (if exists)
  const projectIndex = join(projectPath, ".pi", "wiki", "index.md");
  if (existsSync(projectIndex)) {
    lines.push("## Project Index");
    lines.push(readProfileCached(projectIndex).slice(0, 1000));
    lines.push("");
  }

  // Hot memories (L1, recently accessed)
  const db = getDb();
  const hot = db.prepare(`
    SELECT path, title, content FROM memories
    WHERE tier = 'L1' AND (project_path = ? OR project_path IS NULL)
    ORDER BY last_accessed DESC NULLS LAST, updated_at DESC
    LIMIT 5
  `).all(projectPath) as Array<{ path: string; title: string; content: string }>;

  if (hot.length > 0) {
    lines.push("## Recently Active Memories");
    for (const m of hot) {
      lines.push(`• [[${m.title}]]: ${m.content.slice(0, 200)}${m.content.length > 200 ? "..." : ""}`);
    }
  }

  return lines.join("\n");
}
