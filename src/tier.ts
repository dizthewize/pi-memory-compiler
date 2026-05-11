/**
 * Tiered memory aging system.
 * L1 (0-30d): Full detail, always considered for injection
 * L2 (30-90d): Summarized, considered if relevant
 * L3 (90-365d): Compressed to key bullets, searchable but rarely injected
 * Archive (1y+): One-paragraph summary, linked to raw log
 *
 * Tier transitions happen during compilation.
 * Frontmatter `pin: true` prevents automatic demotion.
 */

import { callLLM } from "./llm.js";
import { loadConfig } from "./config.js";

export type Tier = "L1" | "L2" | "L3" | "archive";

export interface TierRule {
  tier: Tier;
  maxDays: number;
  description: string;
}

export function getTierRules(): TierRule[] {
  const config = loadConfig();
  return [
    { tier: "L1", maxDays: config.tiering.l1Days, description: "Full detail" },
    { tier: "L2", maxDays: config.tiering.l2Days, description: "Summarized" },
    { tier: "L3", maxDays: config.tiering.l3Days, description: "Compressed" },
    { tier: "archive", maxDays: Infinity, description: "One-paragraph summary" },
  ];
}

/**
 * Determine what tier a memory should be in based on its age in days.
 */
export function computeTierFromAge(ageDays: number): Tier {
  const rules = getTierRules();
  for (const rule of rules) {
    if (ageDays <= rule.maxDays) return rule.tier;
  }
  return "archive";
}

/**
 * Check if frontmatter contains `pin: true`.
 */
export function isPinned(content: string): boolean {
  if (!content.startsWith("---")) return false;
  const end = content.indexOf("---", 3);
  if (end === -1) return false;
  const fm = content.slice(3, end);
  return /^pin:\s*true$/m.test(fm) || /\npin:\s*true\n/.test(fm);
}

/**
 * Extract frontmatter from content.
 */
export function extractFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("---", 3);
  if (end === -1) return {};
  const fm: Record<string, string> = {};
  const lines = content.slice(3, end).split("\n");
  for (const line of lines) {
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (match) fm[match[1]] = match[2].trim();
  }
  return fm;
}

/**
 * Replace frontmatter in content.
 */
export function replaceFrontmatter(content: string, updates: Record<string, string>): string {
  const existing = extractFrontmatter(content);
  const merged = { ...existing, ...updates };
  const fmLines = Object.entries(merged).map(([k, v]) => `${k}: ${v}`);
  const body = stripFrontmatter(content);
  return `---\n${fmLines.join("\n")}\n---\n\n${body}`;
}

/**
 * Pin a memory by adding `pin: true` to its frontmatter.
 * Returns true if the memory was pinned, false if already pinned.
 */
export function pinMemory(content: string): { content: string; wasPinned: boolean } {
  if (isPinned(content)) {
    return { content, wasPinned: false };
  }
  return {
    content: replaceFrontmatter(content, { pin: "true" }),
    wasPinned: true,
  };
}

function stripFrontmatter(content: string): string {
  if (content.startsWith("---")) {
    const end = content.indexOf("---", 3);
    if (end !== -1) return content.slice(end + 3).trim();
  }
  return content.trim();
}

/**
 * Summarize content for L1→L2 transition.
 * Keeps key points, removes detailed examples and step-by-step instructions.
 */
export async function summarizeForL2(content: string): Promise<string> {
  const body = stripFrontmatter(content);
  if (body.length < 500) return content; // Already short, no need

  const prompt = `Summarize the following knowledge article into a concise L2-tier memory (200-400 words).
Keep: key concepts, decisions, patterns, and conclusions.
Remove: detailed examples, step-by-step instructions, transient context, code snippets longer than 3 lines.
Write in encyclopedia style — neutral, dense, well-structured.

ARTICLE:
${body.slice(0, 3000)}

SUMMARY:`;

  try {
    const response = await callLLM(prompt, "You are a knowledge compression engine. You distill long articles into dense, durable summaries.");
    return response.content.trim();
  } catch {
    // Fallback: extract first paragraph + bullet points
    const lines = body.split("\n").filter((l) => l.trim());
    const bullets = lines.filter((l) => l.startsWith("- ") || l.startsWith("* "));
    const paragraphs = lines.filter((l) => !l.startsWith("- ") && !l.startsWith("* ") && !l.startsWith("#"));
    const summary = paragraphs.slice(0, 2).join("\n\n");
    const keyBullets = bullets.slice(0, 5);
    return [summary, "", "## Key Points", ...keyBullets].join("\n");
  }
}

/**
 * Compress content for L2→L3 transition.
 * Reduces to key bullets only.
 */
export async function compressForL3(content: string): Promise<string> {
  const body = stripFrontmatter(content);
  if (body.length < 300) return content;

  const prompt = `Compress the following knowledge article into an L3-tier memory (50-100 words, bullet points only).
Keep only: the core concept, one key decision, and one cross-reference.
Remove everything else.

ARTICLE:
${body.slice(0, 2000)}

COMPRESSED:`;

  try {
    const response = await callLLM(prompt, "You are a knowledge compression engine. You reduce articles to their absolute essence.");
    return response.content.trim();
  } catch {
    // Fallback: extract bullets only
    const lines = body.split("\n").filter((l) => l.trim());
    const bullets = lines.filter((l) => l.startsWith("- ") || l.startsWith("* "));
    return bullets.slice(0, 3).join("\n") || lines.slice(0, 2).join("\n");
  }
}

/**
 * Archive content for L3→Archive transition.
 * One paragraph + link to raw log.
 */
export async function archiveContent(content: string, sourcePath: string): Promise<string> {
  const body = stripFrontmatter(content);
  if (body.length < 100) return content;

  const prompt = `Write a one-paragraph archival summary of the following knowledge.
This is the final tier — only the most durable facts remain.
Include a link to the original: [[${sourcePath}]]

ARTICLE:
${body.slice(0, 1500)}

ARCHIVE SUMMARY:`;

  try {
    const response = await callLLM(prompt, "You are an archivist. You write the final, permanent summary of knowledge. One paragraph, timeless facts only.");
    return response.content.trim();
  } catch {
    // Fallback: first sentence of first paragraph
    const firstPara = body.split("\n\n").find((p) => p.trim() && !p.startsWith("#")) || body.slice(0, 200);
    return `${firstPara.slice(0, 300)}\n\n_Original: [[${sourcePath}]]_`;
  }
}

/**
 * Apply a tier transition to content.
 * Returns new content and the tier that was applied.
 */
export async function applyTierTransition(
  content: string,
  fromTier: Tier,
  toTier: Tier,
  sourcePath: string
): Promise<{ content: string; tier: Tier }> {
  if (fromTier === toTier) return { content, tier: fromTier };

  let newContent = content;

  if (fromTier === "L1" && toTier === "L2") {
    newContent = await summarizeForL2(content);
  } else if (fromTier === "L2" && toTier === "L3") {
    newContent = await compressForL3(content);
  } else if ((fromTier === "L3" || fromTier === "L2") && toTier === "archive") {
    newContent = await archiveContent(content, sourcePath);
  }

  // Update frontmatter
  const fm = extractFrontmatter(content);
  const updatedFm = {
    ...fm,
    tier: toTier,
    compressed: new Date().toISOString().slice(0, 10),
    original_tier: fromTier,
  };

  return { content: replaceFrontmatter(newContent, updatedFm), tier: toTier };
}

/**
 * Get the injection priority weight for a tier.
 * Used in search re-ranking.
 */
export function tierInjectionWeight(tier: Tier): number {
  switch (tier) {
    case "L1": return 1.0;
    case "L2": return 0.6;
    case "L3": return 0.2;
    case "archive": return 0.0;
  }
}

/**
 * Should this memory be injected into context based on its tier?
 */
export function shouldInject(tier: Tier, relevanceScore: number): boolean {
  switch (tier) {
    case "L1": return true;
    case "L2": return relevanceScore > 0.7;
    case "L3": return relevanceScore > 0.9;
    case "archive": return false;
  }
}
