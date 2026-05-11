/**
 * Shared utilities for compilation scripts.
 */
import { loadConfig } from "../src/config.js";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, basename } from "path";

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-.]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/\./g, "-")
    .slice(0, 60);
}

export function mergePageContent(existing: string, additions: string[]): string {
  const lines = existing.split("\n");
  const headerEnd = lines.findIndex((l) => l.startsWith("# "));
  const header = headerEnd >= 0 ? lines.slice(0, headerEnd) : [];
  const body = headerEnd >= 0 ? lines.slice(headerEnd) : lines;
  const newLines = [...header, ...body];
  newLines.push("");
  newLines.push(`## Updates (${new Date().toISOString().slice(0, 10)})`);
  for (const add of additions) {
    newLines.push(`- ${add}`);
  }
  return newLines.join("\n");
}

export function getExistingWikiContext(projectPath?: string, maxChars = 8000): string {
  const config = loadConfig();
  const wikiRoot = join(config.vaultPath, projectPath ? `projects/${basename(projectPath)}` : "global-wiki");
  if (!existsSync(wikiRoot)) return "(No existing wiki articles)";

  const parts: string[] = [];
  const dirs = ["concepts", "entities", "decisions", "errors"];
  for (const dir of dirs) {
    const dirPath = join(wikiRoot, dir);
    if (!existsSync(dirPath)) continue;
    const files = readdirSync(dirPath).filter((f) => f.endsWith(".md"));
    for (const file of files.slice(0, 5)) {
      const content = readFileSync(join(dirPath, file), "utf-8").slice(0, 500);
      parts.push(`### ${dir}/${file}\n${content}`);
    }
  }

  let context = parts.join("\n\n");
  if (context.length > maxChars) {
    context = context.slice(0, maxChars) + "\n...(truncated)";
  }
  return context || "(No existing wiki articles)";
}

export interface RawSession {
  sessionId: string;
  project: string;
  events: string[];
  decisions: string[];
  errors: string[];
  files: string[];
}

export function parseRawLog(content: string): RawSession {
  const lines = content.split("\n");
  const session: RawSession = { sessionId: "", project: "", events: [], decisions: [], errors: [], files: [] };
  let section: "none" | "decisions" | "errors" | "files" | "events" | "llm" = "none";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("session_id:")) session.sessionId = line.split(":").slice(1).join(":").trim();
    if (line.startsWith("project:")) session.project = line.split(":").slice(1).join(":").trim();

    if (line === "## Decisions") { section = "decisions"; continue; }
    if (line === "## Errors / Issues") { section = "errors"; continue; }
    if (line === "## Files Touched") { section = "files"; continue; }
    if (line === "## Events") { section = "events"; continue; }
    if (line === "## Context" || line === "## Key Exchanges" || line === "## Lessons Learned" || line === "## Action Items") { section = "llm"; continue; }
    if (line.startsWith("## ")) { section = "none"; continue; }

    if (line.startsWith("- ")) {
      const item = line.slice(2).trim();
      if (section === "decisions") session.decisions.push(item);
      if (section === "errors") session.errors.push(item);
      if (section === "files") session.files.push(item.replace(/`/g, ""));
      if (section === "llm") session.events.push(item);
    }

    if (section === "events") {
      session.events.push(line);
      if (line.startsWith("### [") && i + 1 < lines.length && lines[i + 1].trim()) {
        session.events.push(lines[i + 1]);
        i++;
      }
    }
  }

  return session;
}
