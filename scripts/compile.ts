#!/usr/bin/env tsx
/**
 * Compile: Dream phase — distill raw session logs into structured wiki pages.
 * Supports heuristic (free, fast) or LLM-powered (higher quality) compilation.
 */
import { getDb, closeDb } from "../db/connection.js";
import { insertMemory, updateMemory, getMemoryByPath, insertLink, getWatermark, updateWatermark, getUncompiledSessions, markSessionCompiled } from "../src/db.js";
import { syncEmbeddings } from "../src/embed.js";
import { loadConfig } from "../src/config.js";
import { callLLM, parseArticleBlocks } from "../src/llm.js";
import { computeTierFromAge, isPinned, applyTierTransition } from "../src/tier.js";
import { compileWithParallelSubagents } from "./compile-parallel.js";
import { runLint, writeLintReport } from "./lint.js";
import {
  RawSession,
  parseRawLog,
  slugify,
  mergePageContent,
  getExistingWikiContext,
} from "./compile-utils.js";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, basename, dirname } from "path";
import { gitPush } from "../src/git.js";

export { RawSession, slugify, mergePageContent, getExistingWikiContext } from "./compile-utils.js";

let lastLintTime = 0;
const LINT_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const LINT_MIN_CHANGES = 3;

function extractEntities(session: RawSession): string[] {
  const entities: string[] = [];
  const fullText = [...session.events, ...session.decisions, ...session.errors, ...session.files].join(" ");
  const files = fullText.match(/[\w\-./]+\.(tsx|jsx|ts|js|json|html|css|sql|md|py|go|rs|java)/gi);
  if (files) entities.push(...files);
  const imports = fullText.match(/(?:import|from|require)\s+['"]([^'"]+)['"]/g);
  if (imports) {
    imports.forEach((imp) => {
      const match = imp.match(/['"]([^'"]+)['"]/);
      if (match) entities.push(match[1]);
    });
  }
  return [...new Set(entities)].slice(0, 10);
}

function extractConcepts(session: RawSession): string[] {
  const concepts: string[] = [];
  const fullText = [...session.events, ...session.decisions, ...session.errors, ...session.files].join(" ").toLowerCase();
  const techKeywords = [
    "react", "vue", "angular", "svelte", "node", "express", "fastapi",
    "django", "flask", "docker", "kubernetes", "aws", "gcp", "azure",
    "postgres", "mysql", "mongodb", "redis", "sqlite", "graphql",
    "rest", "api", "auth", "jwt", "oauth", "testing", "ci/cd",
    "typescript", "javascript", "python", "go", "rust", "sql",
    "hooks", "middleware", "routing", "state", "component",
  ];
  for (const kw of techKeywords) {
    if (fullText.includes(kw)) concepts.push(kw);
  }
  return [...new Set(concepts)].slice(0, 5);
}

export function writeWikiPage(path: string, title: string, content: string, projectPath?: string): void {
  const config = loadConfig();
  const fullPath = join(config.vaultPath, projectPath ? `projects/${basename(projectPath)}` : "global-wiki", path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

async function compileWithHeuristic(session: RawSession, now: number, projectSlug: string | undefined): Promise<{ created: number; updated: number }> {
  let pagesCreated = 0;
  let pagesUpdated = 0;

  // Decisions
  if (session.decisions.length > 0) {
    const path = `decisions/session-${session.sessionId.slice(-8)}.md`;
    const title = `Decision: ${session.sessionId.slice(-8)}`;
    const content = `---\ntags: [decision, ${projectSlug ?? "global"}]\ncreated: ${new Date().toISOString().slice(0, 10)}\nproject: ${session.project || "global"}\n---\n\n# ${title}\n\n${session.decisions.map((d) => `- ${d}`).join("\n")}\n\n## Context\n- Session: \`${session.sessionId}\`\n- Project: \`${session.project || "global"}\`\n`;
    const existing = getMemoryByPath(path);
    if (existing) {
      updateMemory(path, { content: mergePageContent(existing.content, session.decisions), updated_at: now });
      pagesUpdated++;
    } else {
      insertMemory({ path, title, content, project_path: session.project || undefined, tier: "L1", created_at: now, updated_at: now, access_count: 0 });
      writeWikiPage(path, title, content, session.project);
      pagesCreated++;
    }
  }

  // Errors
  if (session.errors.length > 0) {
    const path = `errors/session-${session.sessionId.slice(-8)}.md`;
    const title = `Errors: ${session.sessionId.slice(-8)}`;
    const content = `---\ntags: [error, ${projectSlug ?? "global"}]\ncreated: ${new Date().toISOString().slice(0, 10)}\nproject: ${session.project || "global"}\n---\n\n# ${title}\n\n${session.errors.map((e) => `- ${e}`).join("\n")}\n\n## Context\n- Session: \`${session.sessionId}\`\n- Project: \`${session.project || "global"}\`\n`;
    const existing = getMemoryByPath(path);
    if (existing) {
      updateMemory(path, { content: mergePageContent(existing.content, session.errors), updated_at: now });
      pagesUpdated++;
    } else {
      insertMemory({ path, title, content, project_path: session.project || undefined, tier: "L1", created_at: now, updated_at: now, access_count: 0 });
      writeWikiPage(path, title, content, session.project);
      pagesCreated++;
    }
  }

  // Entities
  const entities = extractEntities(session);
  for (const entity of entities) {
    const slug = slugify(entity);
    const path = `entities/${slug}.md`;
    if (!getMemoryByPath(path)) {
      const content = `---\ntags: [entity, ${projectSlug ?? "global"}]\ncreated: ${new Date().toISOString().slice(0, 10)}\n---\n\n# ${entity}\n\n_First observed in session \`${session.sessionId}\` on ${new Date().toISOString().slice(0, 10)}._\n\n## Mentions\n- Project: \`${session.project || "global"}\`\n`;
      insertMemory({ path, title: entity, content, project_path: session.project || undefined, tier: "L1", created_at: now, updated_at: now, access_count: 0 });
      writeWikiPage(path, entity, content, session.project);
      pagesCreated++;
    }
  }

  // Concepts
  const concepts = extractConcepts(session);
  for (const concept of concepts) {
    const slug = slugify(concept);
    const path = `concepts/${slug}.md`;
    if (!getMemoryByPath(path)) {
      const title = concept.charAt(0).toUpperCase() + concept.slice(1);
      const content = `---\ntags: [concept, ${projectSlug ?? "global"}]\ncreated: ${new Date().toISOString().slice(0, 10)}\n---\n\n# ${title}\n\n_First observed in session \`${session.sessionId}\` on ${new Date().toISOString().slice(0, 10)}._\n\n## Mentions\n- Project: \`${session.project || "global"}\`\n`;
      insertMemory({ path, title, content, project_path: session.project || undefined, tier: "L1", created_at: now, updated_at: now, access_count: 0 });
      writeWikiPage(path, title, content, session.project);
      pagesCreated++;
    }
  }

  return { created: pagesCreated, updated: pagesUpdated };
}

async function compileWithLLM(session: RawSession, logContent: string, now: number, projectSlug: string | undefined): Promise<{ created: number; updated: number; cost?: number }> {
  const existingContext = getExistingWikiContext(session.project || undefined);

  const prompt = `You are a knowledge compiler. Read the session log and existing wiki, then create or update wiki articles.

## Wiki Schema
Each article is a markdown file with YAML frontmatter:
\`\`\`
---
tags: [concept|entity|decision|error, project-name]
created: YYYY-MM-DD
sources: [session-id]
---

# Title

## Summary
One paragraph summary.

## Key Points
- 3-5 bullets

## Details
2+ paragraphs of detail.

## Related Concepts
- [[concepts/other-concept]]

## Sources
- Session \`session-id\`
\`\`\`

## Existing Wiki Articles
${existingContext}

## Session Log to Compile
${logContent.slice(0, 6000)}

## Your Task
Create or update wiki articles from this session. Return each article in this exact format:

---ARTICLE---
path: concepts/react-hooks.md
title: React Hooks
content: |
  [full markdown article here]
---END---

Rules:
- **HIGH PRIORITY**: If the session log contains a "📌 Pinned Notes" section, those are explicitly requested by the user. ALWAYS create or update articles for pinned content.
- Only create articles for genuinely important concepts/entities/decisions
- Update existing articles by including their current content plus new info
- Every article must link to at least 2 others via [[path/slug]] wikilinks
- Keep articles concise but comprehensive (300-800 words)
- Use the exact path format: concepts/, entities/, decisions/, errors/
- Project: ${session.project || "global"}
`

  try {
    const response = await callLLM(prompt, "You are a disciplined knowledge compiler. You extract only important, durable knowledge from coding sessions. You write in encyclopedia style — neutral, comprehensive, well-linked.");
    const articles = parseArticleBlocks(response.content);
    let pagesCreated = 0;
    let pagesUpdated = 0;

    for (const article of articles) {
      const fullContent = `---\ntags: [${article.path.split("/")[0]}, ${projectSlug ?? "global"}]\ncreated: ${new Date().toISOString().slice(0, 10)}\nsources: [${session.sessionId}]\n---\n\n${article.content}`;

      const existing = getMemoryByPath(article.path);
      if (existing) {
        updateMemory(article.path, { content: mergePageContent(existing.content, [fullContent]), updated_at: now });
        pagesUpdated++;
      } else {
        insertMemory({
          path: article.path,
          title: article.title,
          content: fullContent,
          project_path: session.project || undefined,
          tier: "L1",
          created_at: now,
          updated_at: now,
          access_count: 0,
        });
        writeWikiPage(article.path, article.title, fullContent, session.project);
        pagesCreated++;
      }

      // Extract and store wikilinks
      const linkMatches = article.content.match(/\[\[([^\]]+)\]\]/g);
      if (linkMatches) {
        for (const link of linkMatches) {
          const target = link.replace(/\[\[|\]\]/g, "");
          insertLink({
            source_path: article.path,
            target_path: target,
            link_type: "reference",
            strength: 1.0,
            created_at: now,
          });
        }
      }
    }

    return { created: pagesCreated, updated: pagesUpdated, cost: response.costUsd };
  } catch (err: any) {
    console.error(`LLM compile failed for ${session.sessionId}: ${err.message}`);
    console.log("Falling back to heuristic compilation...");
    return compileWithHeuristic(session, now, projectSlug);
  }
}

export async function compileSessions(sessionLimit = 20): Promise<{ compiled: number; pagesCreated: number; pagesUpdated: number; totalCost?: number }> {
  const config = loadConfig();
  const mode = config.compile?.mode ?? "heuristic";
  const useLLM = mode === "llm" && config.llm;
  const useParallel = mode === "parallel" && config.llm;
  const rawDir = join(config.vaultPath, "raw-sessions");

  if (!existsSync(rawDir)) {
    console.log("No raw sessions directory found.");
    return { compiled: 0, pagesCreated: 0, pagesUpdated: 0 };
  }

  // Query DB for uncompiled sessions instead of scanning filesystem
  const sessions = getUncompiledSessions(sessionLimit);
  if (sessions.length === 0) {
    console.log("No uncompiled sessions.");
    return { compiled: 0, pagesCreated: 0, pagesUpdated: 0 };
  }

  let processed = 0;
  let pagesCreated = 0;
  let pagesUpdated = 0;
  let totalCost = 0;

  for (const dbSession of sessions) {
    if (processed >= sessionLimit) break;

    // Build log path from session start_time
    const day = new Date(dbSession.start_time).toISOString().slice(0, 10);
    const logPath = join(rawDir, day, `${dbSession.id}.md`);

    if (!existsSync(logPath)) {
      console.log(`  Log file missing for session ${dbSession.id}, marking compiled`);
      markSessionCompiled(dbSession.id);
      continue;
    }

    const logContent = readFileSync(logPath, "utf-8");

    // Skip trivial sessions
    if (logContent.includes("FLUSH_OK")) {
      markSessionCompiled(dbSession.id);
      processed++;
      continue;
    }

    const session = parseRawLog(logContent);
    if (!session.sessionId) {
      markSessionCompiled(dbSession.id);
      continue;
    }
    processed++;

    const now = Date.now();
    const projectSlug = session.project ? basename(session.project) : undefined;

      if (useParallel) {
        console.log(`  Compiling ${session.sessionId} with parallel subagents...`);
        const result = await compileWithParallelSubagents(session, logContent, now, projectSlug);
        pagesCreated += result.created;
        pagesUpdated += result.updated;
        totalCost += result.cost;
        if (result.errors.length > 0) {
          console.log(`  Subagent errors: ${result.errors.join(", ")}`);
        }
      } else if (useLLM) {
        const result = await compileWithLLM(session, logContent, now, projectSlug);
        pagesCreated += result.created;
        pagesUpdated += result.updated;
        if (result.cost) totalCost += result.cost;
      } else {
        const result = await compileWithHeuristic(session, now, projectSlug);
        pagesCreated += result.created;
        pagesUpdated += result.updated;
      }

      markSessionCompiled(session.sessionId);
    }

  updateWatermark("latest", Date.now());

  console.log("Syncing embeddings...");
  const embeddedCount = await syncEmbeddings();
  console.log(`Embedded ${embeddedCount} memories.`);

  // Tier transitions
  const tierResult = await runTierTransitions();
  console.log(`Tier transitions: ${tierResult.transitions} memories updated.`);

  // Auto-lint: lightweight structural check (skip if few changes and recently linted)
  const totalChanges = pagesCreated + pagesUpdated;
  const shouldLint = totalChanges >= LINT_MIN_CHANGES || (Date.now() - lastLintTime) >= LINT_MIN_INTERVAL_MS;

  if (shouldLint) {
    const lintReport = runLint();
    lastLintTime = Date.now();
    if (lintReport.summary.errors > 0 || lintReport.summary.warnings > 0) {
      const issueStr = lintReport.summary.errors > 0
        ? `${lintReport.summary.errors} error(s), ${lintReport.summary.warnings} warning(s)`
        : `${lintReport.summary.warnings} warning(s)`;
      console.log(`Lint: ${issueStr}`);
      writeLintReport(lintReport);
    } else {
      console.log("Lint: ✅ clean");
    }
  } else {
    console.log("Lint: skipped (few changes)");
  }

  const logPath = join(config.vaultPath, "global-wiki", "log.md");
  if (existsSync(logPath)) {
    const logContent = readFileSync(logPath, "utf-8");
    const costStr = totalCost > 0 ? ` ($${totalCost.toFixed(4)})` : "";
    const newEntry = `## [${new Date().toISOString().slice(0, 10)} ${new Date().toISOString().slice(11, 16)}] compile | Compiled ${processed} sessions into ${pagesCreated} new pages and ${pagesUpdated} updated pages${costStr}`;
    writeFileSync(logPath, logContent + "\n" + newEntry + "\n");
  }

  // Auto-push to git if configured and changes were made
  if ((pagesCreated > 0 || pagesUpdated > 0) && config.obsidian?.syncOnCompile) {
    console.log("Pushing to git...");
    const gitResult = gitPush(config.vaultPath, `pi-memory: compiled ${processed} sessions (+${pagesCreated} pages, ~${pagesUpdated} updates)`);
    if (gitResult.ok) {
      console.log("  ✅ Pushed to remote");
    } else {
      console.log(`  ⚠️  Git push skipped: ${gitResult.error || "no changes"}`);
    }
  }

  console.log(`Compilation complete: ${processed} sessions, ${pagesCreated} pages created, ${pagesUpdated} pages updated.${totalCost > 0 ? ` Cost: $${totalCost.toFixed(4)}` : ""}`);
  return { compiled: processed, pagesCreated, pagesUpdated, totalCost: totalCost > 0 ? totalCost : undefined };
}

/**
 * Run tier transitions on memories that are old enough to possibly transition.
 * Demote old memories to lower tiers, skip pinned ones.
 */
export async function runTierTransitions(): Promise<{ transitions: number }> {
  const db = getDb();
  const config = loadConfig();
  const now = Date.now();
  const msPerDay = 24 * 60 * 60 * 1000;
  const l1Threshold = now - config.tiering.l1Days * msPerDay;
  const l2Threshold = now - config.tiering.l2Days * msPerDay;
  const l3Threshold = now - config.tiering.l3Days * msPerDay;

  // Only query memories that could possibly transition
  const memories = db.prepare(`
    SELECT * FROM memories
    WHERE (tier = 'L1' AND updated_at < ?)
       OR (tier = 'L2' AND updated_at < ?)
       OR (tier = 'L3' AND updated_at < ?)
  `).all(l1Threshold, l2Threshold, l3Threshold) as Array<{
    id: number;
    path: string;
    content: string;
    tier: string;
    updated_at: number;
  }>;

  let transitions = 0;

  for (const mem of memories) {
    if (isPinned(mem.content)) continue;

    const ageDays = (now - mem.updated_at) / (24 * 60 * 60 * 1000);
    const targetTier = computeTierFromAge(ageDays);

    if (targetTier !== mem.tier) {
      const result = await applyTierTransition(mem.content, mem.tier as any, targetTier, mem.path);
      updateMemory(mem.path, {
        content: result.content,
        tier: result.tier,
        updated_at: now,
      });
      transitions++;
    }
  }

  return { transitions };
}

// CLI entrypoint
if (import.meta.url === process.argv[1] || process.argv[1]?.endsWith("compile.ts")) {
  const limit = process.argv[2] ? parseInt(process.argv[2], 10) : 20;
  compileSessions(limit).then(() => closeDb());
}
