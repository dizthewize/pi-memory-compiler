/**
 * Parallel Dream Phase: Fan out compilation to 4 specialized subagents.
 * Each subagent handles one category: concepts, entities, decisions, profile.
 * Results are merged, deduplicated, and written to the wiki.
 */

import { insertMemory, updateMemory, getMemoryByPath, insertLink } from "../src/db.js";
import { callLLM, parseArticleBlocks } from "../src/llm.js";
import { writeWikiPage, mergePageContent, getExistingWikiContext } from "./compile.js";
import type { RawSession } from "./compile-utils.js";

export interface SubagentResult {
  category: "concepts" | "entities" | "decisions" | "profile";
  articles: Array<{ path: string; title: string; content: string }>;
  cost?: number;
  error?: string;
}

// ── Subagent Prompts ───────────────────────────────────────

function buildConceptsPrompt(session: RawSession, logContent: string, existingContext: string): string {
  return `You are a Concept Compiler. Extract technical concepts, patterns, frameworks, and architectural ideas from this session.

## Existing Concepts
${existingContext}

## Session Log
${logContent.slice(0, 4000)}

## Your Task
Create or update concept articles. Focus on:
- Technical patterns (e.g., "React Hooks pattern", "CQRS architecture")
- Framework usage (e.g., "Next.js App Router", "TanStack Query caching")
- Algorithms and data structures
- Design patterns and best practices

**HIGH PRIORITY**: If the session log contains a "📌 Pinned Notes" section, the user explicitly requested preservation of that content. Extract it into concept articles even if it seems obvious — the user wants it remembered.

Return each article in this format:

---ARTICLE---
path: concepts/react-hooks-pattern.md
title: React Hooks Pattern
content: |
  # React Hooks Pattern

  ## Summary
  One paragraph.

  ## Key Points
  - Bullets

  ## Details
  Paragraphs.

  ## Related
  - [[concepts/other-concept]]
---END---

Rules:
- Only genuinely important, reusable concepts
- Link to related concepts via [[path/slug]]
- 300-600 words each
- Project: ${session.project || "global"}`;
}

function buildEntitiesPrompt(session: RawSession, logContent: string, existingContext: string): string {
  return `You are an Entity Compiler. Extract named entities: libraries, APIs, tools, people, file types, and external services.

## Existing Entities
${existingContext}

## Session Log
${logContent.slice(0, 4000)}

## Your Task
Create or update entity articles. Focus on:
- Libraries and frameworks (e.g., "axios", "Prisma", "Tailwind CSS")
- APIs and services (e.g., "OpenAI API", "GitHub Actions")
- Tools and CLIs (e.g., "vitest", "eslint", "docker")
- File types and formats
- People or teams mentioned

**HIGH PRIORITY**: If the session log contains a "📌 Pinned Notes" section mentioning specific tools or libraries, create/update entity articles for them. The user explicitly wants these remembered.

Return each article in this format:

---ARTICLE---
path: entities/axios.md
title: Axios
content: |
  # Axios

  ## Summary
  HTTP client library.

  ## Usage in this project
  How it was used in this session.

  ## Related
  - [[entities/fetch-api]]
---END---

Rules:
- Only entities that are significant or recurring
- Include how the entity was used in this session
- Link to related entities
- 200-400 words each
- Project: ${session.project || "global"}`;
}

function buildDecisionsPrompt(session: RawSession, logContent: string, existingContext: string): string {
  return `You are a Decision Recorder. Extract architectural decisions, tradeoffs, and design choices.

## Existing Decisions
${existingContext}

## Session Log
${logContent.slice(0, 4000)}

## Your Task
Create or update decision records (ADRs). Focus on:
- "We chose X over Y because..."
- "We decided to avoid Z due to..."
- Configuration choices
- Tool/library selections
- Architecture patterns adopted or rejected

**HIGH PRIORITY**: If the session log contains a "📌 Pinned Notes" section, the user explicitly wants those patterns/solutions preserved. Create decision records for any design choices mentioned in pinned notes.

Return each article in this format:

---ARTICLE---
path: decisions/choose-sqlite-over-postgres.md
title: Choose SQLite over PostgreSQL
content: |
  # Choose SQLite over PostgreSQL

  ## Context
  Why this decision was needed.

  ## Decision
  What was chosen.

  ## Consequences
  - Positive: ...
  - Negative: ...

  ## Status
  Accepted

  ## Related
  - [[decisions/other-decision]]
---END---

Rules:
- Only record actual decisions made, not speculation
- Include context, decision, and consequences
- Use ADR format
- Link to related decisions
- 300-500 words each
- Project: ${session.project || "global"}`;
}

function buildProfilePrompt(session: RawSession, logContent: string): string {
  return `You are a Profile Observer. Detect user preferences, habits, and patterns from this session.

## Session Log
${logContent.slice(0, 4000)}

## Your Task
Update the user profile with any new patterns observed. Focus on:
- Preferred tools or frameworks
- Coding style preferences
- Communication patterns
- Workflow habits
- Things the user dislikes or avoids

**HIGH PRIORITY**: If the session log contains a "📌 Pinned Notes" section, the user is telling you what matters to them. Update the profile to reflect any preferences or patterns mentioned in pinned notes.

Return profile updates in this format:

---ARTICLE---
path: profile/preferences.md
title: User Preferences
content: |
  # User Preferences

  ## Observed Patterns
  - Pattern from this session

  ## Preferences
  - Prefers X over Y
---END---

Or:

---ARTICLE---
path: profile/patterns.md
title: Coding Patterns
content: |
  # Coding Patterns

  ## Patterns
  - Pattern observed
---END---

Rules:
- Only high-confidence observations
- Be neutral and factual
- Don't invent preferences not demonstrated
- 100-300 words each`;
}

// ── Subagent Execution ─────────────────────────────────────

async function runSubagent(
  category: SubagentResult["category"],
  prompt: string,
  systemPrompt: string
): Promise<SubagentResult> {
  const start = Date.now();
  try {
    const response = await callLLM(prompt, systemPrompt);
    const articles = parseArticleBlocks(response.content);
    console.log(`  [${category}] ${articles.length} articles in ${Date.now() - start}ms`);
    return {
      category,
      articles: articles.map((a) => ({ path: a.path, title: a.title, content: a.content })),
      cost: response.costUsd,
    };
  } catch (err: any) {
    console.error(`  [${category}] FAILED: ${err.message}`);
    return {
      category,
      articles: [],
      error: err.message,
    };
  }
}

// ── Parallel Compilation ───────────────────────────────────

export async function compileWithParallelSubagents(
  session: RawSession,
  logContent: string,
  now: number,
  projectSlug: string | undefined
): Promise<{ created: number; updated: number; cost: number; errors: string[] }> {
  const conceptsContext = getExistingWikiContext(session.project || undefined, 2000).replace(/### entities|### decisions|### errors/g, "");
  const entitiesContext = getExistingWikiContext(session.project || undefined, 2000).replace(/### concepts|### decisions|### errors/g, "");
  const decisionsContext = getExistingWikiContext(session.project || undefined, 2000).replace(/### concepts|### entities|### errors/g, "");

  // Fan out to 4 parallel subagents
  const results = await Promise.all([
    runSubagent(
      "concepts",
      buildConceptsPrompt(session, logContent, conceptsContext),
      "You are a Concept Compiler. You extract deep technical knowledge, patterns, and frameworks. You write encyclopedia-style articles that are durable and reusable."
    ),
    runSubagent(
      "entities",
      buildEntitiesPrompt(session, logContent, entitiesContext),
      "You are an Entity Compiler. You identify libraries, tools, APIs, and services. You document what they are and how they were used."
    ),
    runSubagent(
      "decisions",
      buildDecisionsPrompt(session, logContent, decisionsContext),
      "You are a Decision Recorder. You capture architectural decisions, tradeoffs, and design choices in ADR format."
    ),
    runSubagent(
      "profile",
      buildProfilePrompt(session, logContent),
      "You are a Profile Observer. You detect user preferences, habits, and patterns from their behavior. You are conservative — only record what you observe."
    ),
  ]);

  let pagesCreated = 0;
  let pagesUpdated = 0;
  let totalCost = 0;
  const errors: string[] = [];

  // Collect all articles
  const allArticles: Array<{ path: string; title: string; content: string; category: string }> = [];
  for (const result of results) {
    if (result.error) {
      errors.push(`${result.category}: ${result.error}`);
      continue;
    }
    if (result.cost) totalCost += result.cost;
    for (const article of result.articles) {
      allArticles.push({ ...article, category: result.category });
    }
  }

  // Deduplicate by path
  const seenPaths = new Set<string>();
  const deduped = allArticles.filter((a) => {
    if (seenPaths.has(a.path)) return false;
    seenPaths.add(a.path);
    return true;
  });

  // Write to database and vault
  for (const article of deduped) {
    const fullContent = `---\ntags: [${article.category}, ${projectSlug ?? "global"}]\ncreated: ${new Date().toISOString().slice(0, 10)}\nsources: [${session.sessionId}]\n---\n\n${article.content}`;

    const existing = getMemoryByPath(article.path);
    if (existing) {
      updateMemory(article.path, {
        content: mergePageContent(existing.content, [fullContent]),
        updated_at: now,
      });
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

    // Extract wikilinks
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

  return { created: pagesCreated, updated: pagesUpdated, cost: totalCost, errors };
}
