#!/usr/bin/env tsx
/**
 * Lint: Health checks for the Pi-Memory knowledge vault.
 * Structural checks are fast (pure SQL + regex). Contradiction detection is optional (LLM-powered, slow).
 */
import { getDb, closeDb } from "../db/connection.js";
import type { Memory } from "../src/types.js";
import { loadConfig } from "../src/config.js";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

// ── Types ──────────────────────────────────────────────────

export interface LintIssue {
  severity: "error" | "warn" | "info";
  check: string;
  path: string;
  message: string;
  fix?: string;
}

export interface LintReport {
  timestamp: number;
  summary: {
    totalPages: number;
    totalLinks: number;
    errors: number;
    warnings: number;
    infos: number;
  };
  issues: LintIssue[];
  stats: {
    orphans: number;
    brokenLinks: number;
    stalePages: number;
    duplicates: number;
    emptyPages: number;
    untiered: number;
  };
  markdown: string;
}

// ── Helpers ────────────────────────────────────────────────

function nowMs(): number {
  return Date.now();
}

function daysAgo(days: number): number {
  return nowMs() - days * 24 * 60 * 60 * 1000;
}

function stripFrontmatter(content: string): string {
  if (content.startsWith("---")) {
    const end = content.indexOf("---", 3);
    if (end !== -1) return content.slice(end + 3).trim();
  }
  return content.trim();
}

function extractWikiLinks(content: string): string[] {
  const matches = content.match(/\[\[([^\]]+)\]\]/g);
  if (!matches) return [];
  return matches.map((m) => m.replace(/\[\[|\]\]/g, ""));
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-.]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
}

// ── Check Implementations ──────────────────────────────────

function checkOrphans(db: ReturnType<typeof getDb>, issues: LintIssue[]): number {
  const orphans = db.prepare(`
    SELECT path, title FROM memories
    WHERE path NOT IN (SELECT DISTINCT target_path FROM links)
      AND path NOT IN (SELECT DISTINCT source_path FROM links)
  `).all() as Array<{ path: string; title: string }>;

  for (const o of orphans) {
    issues.push({
      severity: "warn",
      check: "orphan",
      path: o.path,
      message: `Page "${o.title}" has no inbound or outbound links`,
      fix: `Add [[${o.path.replace(/\.md$/, "")}]] links to/from related pages`,
    });
  }
  return orphans.length;
}

function checkBrokenLinks(db: ReturnType<typeof getDb>, issues: LintIssue[]): number {
  let count = 0;

  // Check links table for dangling targets
  const danglingFromTable = db.prepare(`
    SELECT DISTINCT l.target_path
    FROM links l
    LEFT JOIN memories m ON l.target_path = m.path
    WHERE m.path IS NULL
  `).all() as Array<{ target_path: string }>;

  for (const d of danglingFromTable) {
    issues.push({
      severity: "error",
      check: "broken-link",
      path: d.target_path,
      message: `Dangling link target: "${d.target_path}" (referenced in links table but no page exists)`,
      fix: `Create page at ${d.target_path} or remove references`,
    });
    count++;
  }

  // Check content for [[wiki-links]] that don't exist
  const memories = db.prepare("SELECT path, content FROM memories").all() as Array<{ path: string; content: string }>;
  const allPaths = new Set(memories.map((m) => m.path));

  for (const mem of memories) {
    const links = extractWikiLinks(mem.content);
    for (const link of links) {
      // Link might be a path (concepts/foo) or a title — try both
      const asPath = link.endsWith(".md") ? link : `${link}.md`;
      const asSlugPath = `concepts/${slugify(link)}.md`;
      const asEntityPath = `entities/${slugify(link)}.md`;
      const exists = allPaths.has(link) || allPaths.has(asPath) || allPaths.has(asSlugPath) || allPaths.has(asEntityPath);
      if (!exists) {
        issues.push({
          severity: "error",
          check: "broken-link",
          path: mem.path,
          message: `Broken wiki-link "[[${link}]]" in ${mem.path}`,
          fix: `Create page for "${link}" or fix the link`,
        });
        count++;
      }
    }
  }

  return count;
}

function checkStalePages(db: ReturnType<typeof getDb>, issues: LintIssue[]): number {
  const staleThreshold = daysAgo(90);
  const recentThreshold = daysAgo(30);

  const stale = db.prepare(`
    SELECT DISTINCT m.path, m.title, m.updated_at
    FROM memories m
    JOIN links l ON m.path = l.target_path
    JOIN memories source ON l.source_path = source.path
    WHERE m.updated_at < ?
      AND source.tier = 'L1'
      AND source.updated_at > ?
  `).all(staleThreshold, recentThreshold) as Array<{ path: string; title: string; updated_at: number }>;

  for (const s of stale) {
    const ageDays = Math.round((nowMs() - s.updated_at) / (24 * 60 * 60 * 1000));
    issues.push({
      severity: "warn",
      check: "stale",
      path: s.path,
      message: `Page "${s.title}" is ${ageDays} days old but referenced by recent L1 memories`,
      fix: `Review and update ${s.path}, or mark as superseded`,
    });
  }
  return stale.length;
}

function checkDuplicates(db: ReturnType<typeof getDb>, issues: LintIssue[]): number {
  const memories = db.prepare("SELECT path, title, content FROM memories").all() as Array<{ path: string; title: string; content: string }>;
  const seen = new Map<string, string>(); // normalized title -> path
  let count = 0;

  for (const mem of memories) {
    const normalized = slugify(mem.title);
    if (seen.has(normalized) && seen.get(normalized) !== mem.path) {
      issues.push({
        severity: "warn",
        check: "duplicate",
        path: mem.path,
        message: `Possible duplicate: "${mem.title}" similar to "${seen.get(normalized)}"`,
        fix: `Merge ${mem.path} into ${seen.get(normalized)} or differentiate titles`,
      });
      count++;
    } else {
      seen.set(normalized, mem.path);
    }
  }

  return count;
}

function checkEmptyPages(db: ReturnType<typeof getDb>, issues: LintIssue[]): number {
  const memories = db.prepare("SELECT path, title, content FROM memories").all() as Array<{ path: string; title: string; content: string }>;
  let count = 0;

  for (const mem of memories) {
    const body = stripFrontmatter(mem.content);
    if (body.length < 100) {
      issues.push({
        severity: "info",
        check: "empty",
        path: mem.path,
        message: `Page "${mem.title}" is very short (${body.length} chars after frontmatter)`,
        fix: `Expand content or remove if not useful`,
      });
      count++;
    }
  }

  return count;
}

function checkUntiered(db: ReturnType<typeof getDb>, issues: LintIssue[]): number {
  const untiered = db.prepare(`
    SELECT path, title FROM memories
    WHERE tier IS NULL OR tier = ''
  `).all() as Array<{ path: string; title: string }>;

  for (const u of untiered) {
    issues.push({
      severity: "warn",
      check: "untiered",
      path: u.path,
      message: `Page "${u.title}" has no tier assigned`,
      fix: `Set tier to L1, L2, L3, or archive`,
    });
  }
  return untiered.length;
}

function checkMissingLinks(db: ReturnType<typeof getDb>, issues: LintIssue[]): number {
  // Find memories that have no outbound links at all
  const unlinked = db.prepare(`
    SELECT m.path, m.title, m.content FROM memories m
    WHERE m.path NOT IN (SELECT DISTINCT source_path FROM links)
  `).all() as Array<{ path: string; title: string; content: string }>;

  let count = 0;
  for (const mem of unlinked) {
    // Only warn if the content doesn't even have [[...]] syntax
    const hasWikiLinks = /\[\[/.test(mem.content);
    if (!hasWikiLinks) {
      issues.push({
        severity: "info",
        check: "missing-links",
        path: mem.path,
        message: `Page "${mem.title}" has no outbound wiki-links`,
        fix: `Add [[related-concept]] links to connect this page to the knowledge graph`,
      });
      count++;
    }
  }
  return count;
}

// ── Report Generation ──────────────────────────────────────

function buildMarkdownReport(report: LintReport): string {
  const lines: string[] = [
    "# Pi-Memory Health Report",
    "",
    `**Generated:** ${new Date(report.timestamp).toISOString()}`,
    "",
    "## Summary",
    "",
    `| Metric | Value |`,
    `|---|---|`,
    `| Total Pages | ${report.summary.totalPages} |`,
    `| Total Links | ${report.summary.totalLinks} |`,
    `| Errors | ${report.summary.errors} |`,
    `| Warnings | ${report.summary.warnings} |`,
    `| Infos | ${report.summary.infos} |`,
    "",
    "## Stats",
    "",
    `| Check | Count |`,
    `|---|---|`,
    `| Orphan Pages | ${report.stats.orphans} |`,
    `| Broken Links | ${report.stats.brokenLinks} |`,
    `| Stale Pages | ${report.stats.stalePages} |`,
    `| Duplicates | ${report.stats.duplicates} |`,
    `| Empty Pages | ${report.stats.emptyPages} |`,
    `| Untiered Pages | ${report.stats.untiered} |`,
    "",
    "## Issues",
    "",
  ];

  if (report.issues.length === 0) {
    lines.push("✅ No issues found. Vault is healthy!");
  } else {
    for (const issue of report.issues) {
      const icon = issue.severity === "error" ? "❌" : issue.severity === "warn" ? "⚠️" : "ℹ️";
      lines.push(`${icon} **${issue.check}** — \`${issue.path}\``);
      lines.push(`   ${issue.message}`);
      if (issue.fix) lines.push(`   💡 Fix: ${issue.fix}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ── Main ───────────────────────────────────────────────────

export function runLint(): LintReport {
  const db = getDb();
  const issues: LintIssue[] = [];

  const totalPages = (db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;
  const totalLinks = (db.prepare("SELECT COUNT(*) as c FROM links").get() as { c: number }).c;

  const orphans = checkOrphans(db, issues);
  const brokenLinks = checkBrokenLinks(db, issues);
  const stalePages = checkStalePages(db, issues);
  const duplicates = checkDuplicates(db, issues);
  const emptyPages = checkEmptyPages(db, issues);
  const untiered = checkUntiered(db, issues);
  checkMissingLinks(db, issues); // info-level only

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warn").length;
  const infos = issues.filter((i) => i.severity === "info").length;

  const report: LintReport = {
    timestamp: nowMs(),
    summary: { totalPages, totalLinks, errors, warnings, infos },
    issues,
    stats: { orphans, brokenLinks, stalePages, duplicates, emptyPages, untiered },
    markdown: "",
  };

  report.markdown = buildMarkdownReport(report);
  return report;
}

export function writeLintReport(report: LintReport): string {
  const config = loadConfig();
  const reportPath = join(config.vaultPath, "global-wiki", "lint-reports", `report-${new Date(report.timestamp).toISOString().slice(0, 10)}.md`);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, report.markdown);
  return reportPath;
}

// CLI entrypoint
if (import.meta.url === process.argv[1] || process.argv[1]?.endsWith("lint.ts")) {
  const report = runLint();
  console.log(report.markdown);

  const reportPath = writeLintReport(report);
  console.log(`\n📄 Full report written to: ${reportPath}`);

  // Exit with error code if there are errors
  if (report.summary.errors > 0) {
    process.exit(1);
  }
  closeDb();
}
