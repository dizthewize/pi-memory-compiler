#!/usr/bin/env tsx
/**
 * Performance benchmarks for Pi-Memory.
 * Measures query latency, compile time, DB size, and memory usage.
 */

import { getDb, closeDb, setDbOverride } from "../db/connection.js";
import { initDatabase } from "../db/init-db.js";
import {
  insertMemory,
  insertEvent,
  insertSession,
  insertLink,
  searchHybrid,
  getUncompiledSessions,
} from "../src/db.js";
import { generateEmbedding, syncEmbeddings } from "../src/embed.js";
import { buildMemoryInjection } from "../src/inject.js";
import { compileSessions } from "./compile.js";
import { runLint } from "./lint.js";
import { runTierTransitions } from "./compile.js";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { loadConfig } from "../src/config.js";

// ── Types ──────────────────────────────────────────────────

export interface BenchmarkResult {
  name: string;
  durationMs: number;
  metric?: number;
  unit?: string;
  passed: boolean;
  target: string;
  details?: string;
}

export interface BenchmarkReport {
  timestamp: number;
  results: BenchmarkResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
  markdown: string;
}

// ── Helpers ────────────────────────────────────────────────

function nowMs(): number {
  return Date.now();
}

function time<T>(fn: () => T): { result: T; durationMs: number } {
  const start = performance.now();
  const result = fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}

async function timeAsync<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  return { result, durationMs };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Synthetic Data Generators ──────────────────────────────

function generateSyntheticMemory(index: number, tier: "L1" | "L2" | "L3" | "archive" = "L1"): {
  path: string;
  title: string;
  content: string;
  tier: string;
} {
  const topics = [
    "React Hooks", "TypeScript Generics", "Database Indexing", "API Design",
    "Authentication", "State Management", "Docker Containers", "CI/CD Pipelines",
    "GraphQL Resolvers", "Microservices", "Event Sourcing", "CQRS Pattern",
    "Redis Caching", "Kafka Streaming", "Kubernetes Pods", "Terraform IaC",
    "Next.js Routing", "Prisma ORM", "Tailwind CSS", "Jest Testing",
  ];
  const topic = topics[index % topics.length];
  const path = `concepts/${topic.toLowerCase().replace(/\s+/g, "-")}.md`;

  let content: string;
  switch (tier) {
    case "L1":
      content = `---\ntags: [concept, benchmark]\ntier: L1\n---\n\n# ${topic}\n\n## Summary\nThis is a detailed article about ${topic}. It covers the core concepts, implementation details, and best practices.\n\n## Key Points\n- Point one about ${topic}\n- Point two about ${topic}\n- Point three about ${topic}\n- Point four about ${topic}\n- Point five about ${topic}\n\n## Details\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.\n\n## Related\n- [[concepts/related-topic]]\n- [[concepts/another-topic]]\n`;
      break;
    case "L2":
      content = `---\ntags: [concept, benchmark]\ntier: L2\n---\n\n# ${topic}\n\n## Summary\nSummarized version of ${topic}. Key concept for state management in React applications.\n\n## Key Points\n- Main pattern\n- Usage guidelines\n- Common pitfalls\n`;
      break;
    case "L3":
      content = `---\ntags: [concept, benchmark]\ntier: L3\n---\n\n# ${topic}\n\n- Core pattern for ${topic}\n- Used in project X\n- See [[concepts/react-hooks]] for details\n`;
      break;
    default:
      content = `---\ntags: [concept, benchmark]\ntier: archive\n---\n\n# ${topic}\n\nArchived summary of ${topic}. Original: [[concepts/${topic.toLowerCase().replace(/\s+/g, "-")}]]\n`;
  }

  return { path, title: topic, content, tier };
}

function generateSyntheticSession(index: number): {
  id: string;
  project_path: string;
  start_time: number;
  end_time: number;
  event_count: number;
} {
  const projects = ["/home/ubuntu24/project-a", "/home/ubuntu24/project-b", "/home/ubuntu24/project-c"];
  const start = nowMs() - index * 24 * 60 * 60 * 1000;
  return {
    id: `sess-bench-${index}`,
    project_path: projects[index % projects.length],
    start_time: start,
    end_time: start + 30 * 60 * 1000,
    event_count: 10 + (index % 20),
  };
}

function generateSyntheticEvents(sessionId: string, count: number): Array<{
  session_id: string;
  event_type: string;
  timestamp: number;
  content: string;
}> {
  const events = [];
  const types = ["tool_call", "tool_result", "turn", "command"];
  const contents = [
    "Discussed React component architecture",
    "Fixed bug in authentication middleware",
    "Refactored database schema",
    "Added new API endpoint",
    "Configured CI/CD pipeline",
    "Updated dependencies",
    "Wrote unit tests",
    "Reviewed pull request",
    "Deployed to staging",
    "Investigated performance issue",
  ];

  for (let i = 0; i < count; i++) {
    events.push({
      session_id: sessionId,
      event_type: types[i % types.length],
      timestamp: nowMs() - i * 60 * 1000,
      content: contents[i % contents.length],
    });
  }
  return events;
}

// ── Benchmark Implementations ──────────────────────────────

async function benchmarkQueryLatency(memoryCount: number): Promise<BenchmarkResult> {
  const testDb = initDatabase(":memory:");
  setDbOverride(testDb);

  // Insert synthetic memories
  const now = nowMs();
  for (let i = 0; i < memoryCount; i++) {
    const mem = generateSyntheticMemory(i);
    insertMemory({
      path: mem.path,
      title: mem.title,
      content: mem.content,
      tier: "L1",
      created_at: now,
      updated_at: now,
      access_count: 0,
    });
  }

  // Sync embeddings
  await syncEmbeddings();

  // Benchmark queries
  const queries = ["react hooks", "database indexing", "api design", "authentication"];
  let totalDuration = 0;

  for (const query of queries) {
    const embedding = await generateEmbedding(query);
    const { durationMs } = await timeAsync(async () => {
      searchHybrid(embedding, query, { limit: 10 });
    });
    totalDuration += durationMs;
  }

  const avgDuration = totalDuration / queries.length;
  const targetMs = 200;

  setDbOverride(null);
  testDb.close();

  return {
    name: `Query Latency (${memoryCount} memories)`,
    durationMs: avgDuration,
    metric: avgDuration,
    unit: "ms",
    passed: avgDuration < targetMs,
    target: `< ${targetMs}ms`,
    details: `Average of ${queries.length} queries`,
  };
}

async function benchmarkMemoryInjection(memoryCount: number): Promise<BenchmarkResult> {
  const testDb = initDatabase(":memory:");
  setDbOverride(testDb);

  const now = nowMs();
  for (let i = 0; i < memoryCount; i++) {
    const mem = generateSyntheticMemory(i);
    insertMemory({
      path: mem.path,
      title: mem.title,
      content: mem.content,
      tier: "L1",
      created_at: now,
      updated_at: now,
      access_count: 0,
    });
  }

  await syncEmbeddings();

  const { durationMs } = await timeAsync(async () => {
    await buildMemoryInjection("how do I handle authentication", "/home/ubuntu24/project-a");
  });

  const targetMs = 500;

  setDbOverride(null);
  testDb.close();

  return {
    name: `Memory Injection (${memoryCount} memories)`,
    durationMs,
    metric: durationMs,
    unit: "ms",
    passed: durationMs < targetMs,
    target: `< ${targetMs}ms`,
    details: "Full pipeline: embed → search → format → inject",
  };
}

async function benchmarkDbSize(sessionCount: number): Promise<BenchmarkResult> {
  const testDb = initDatabase(":memory:");
  setDbOverride(testDb);

  const now = nowMs();

  // Insert sessions and events
  for (let i = 0; i < sessionCount; i++) {
    const session = generateSyntheticSession(i);
    insertSession({
      id: session.id,
      project_path: session.project_path,
      start_time: session.start_time,
      end_time: session.end_time,
      compiled: 0,
      event_count: session.event_count,
    });

    const events = generateSyntheticEvents(session.id, session.event_count);
    for (const event of events) {
      insertEvent(event);
    }
  }

  // Insert memories (roughly 5 per session)
  for (let i = 0; i < sessionCount * 5; i++) {
    const mem = generateSyntheticMemory(i);
    insertMemory({
      path: mem.path,
      title: mem.title,
      content: mem.content,
      tier: "L1",
      created_at: now,
      updated_at: now,
      access_count: 0,
    });
  }

  // Insert links
  for (let i = 0; i < sessionCount * 3; i++) {
    insertLink({
      source_path: `concepts/topic-${i}.md`,
      target_path: `concepts/topic-${(i + 1) % 100}.md`,
      link_type: "reference",
      strength: 1.0,
      created_at: now,
    });
  }

  // Sync embeddings
  await syncEmbeddings();

  // Get DB size via SQLite page count
  const pageCount = (testDb.prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()").get() as { size: number }).size;
  const sizeBytes = pageCount;
  const targetMb = 50;

  setDbOverride(null);
  testDb.close();

  return {
    name: `DB Size (${sessionCount} sessions)`,
    durationMs: 0,
    metric: sizeBytes,
    unit: "bytes",
    passed: sizeBytes < targetMb * 1024 * 1024,
    target: `< ${targetMb}MB`,
    details: `Actual: ${formatBytes(sizeBytes)}`,
  };
}

async function benchmarkHybridSearchScaling(): Promise<BenchmarkResult[]> {
  const sizes = [10, 50, 100, 500];
  const results: BenchmarkResult[] = [];

  for (const size of sizes) {
    const result = await benchmarkQueryLatency(size);
    result.name = `Hybrid Search Scaling (${size} memories)`;
    results.push(result);
  }

  return results;
}

async function benchmarkLintSpeed(memoryCount: number): Promise<BenchmarkResult> {
  const testDb = initDatabase(":memory:");
  setDbOverride(testDb);

  const now = nowMs();
  for (let i = 0; i < memoryCount; i++) {
    const mem = generateSyntheticMemory(i);
    insertMemory({
      path: mem.path,
      title: mem.title,
      content: mem.content,
      tier: "L1",
      created_at: now,
      updated_at: now,
      access_count: 0,
    });
  }

  // Add some links
  for (let i = 0; i < memoryCount / 2; i++) {
    insertLink({
      source_path: `concepts/topic-${i}.md`,
      target_path: `concepts/topic-${(i + 1) % memoryCount}.md`,
      link_type: "reference",
      strength: 1.0,
      created_at: now,
    });
  }

  const { durationMs } = time(() => {
    runLint();
  });

  const targetMs = 1000;

  setDbOverride(null);
  testDb.close();

  return {
    name: `Lint Speed (${memoryCount} memories)`,
    durationMs,
    metric: durationMs,
    unit: "ms",
    passed: durationMs < targetMs,
    target: `< ${targetMs}ms`,
    details: "Full lint: orphans + broken links + stale + duplicates + empty",
  };
}

// ── Report Generation ──────────────────────────────────────

function buildMarkdownReport(report: BenchmarkReport): string {
  const lines: string[] = [
    "# Pi-Memory Performance Benchmarks",
    "",
    `**Generated:** ${new Date(report.timestamp).toISOString()}`,
    "",
    "## Summary",
    "",
    `| Metric | Value |`,
    `|---|---|`,
    `| Total Benchmarks | ${report.summary.total} |`,
    `| Passed | ${report.summary.passed} ✅ |`,
    `| Failed | ${report.summary.failed} ❌ |`,
    `| Pass Rate | ${((report.summary.passed / report.summary.total) * 100).toFixed(1)}% |`,
    "",
    "## Results",
    "",
    `| Benchmark | Duration | Metric | Target | Status |`,
    `|---|---|---|---|---|`,
  ];

  for (const r of report.results) {
    const icon = r.passed ? "✅" : "❌";
    const metricStr = r.metric !== undefined ? `${r.metric.toFixed(1)} ${r.unit}` : "—";
    lines.push(`| ${r.name} | ${r.durationMs.toFixed(0)}ms | ${metricStr} | ${r.target} | ${icon} |`);
  }

  lines.push("");
  lines.push("## Details");
  lines.push("");

  for (const r of report.results) {
    const icon = r.passed ? "✅" : "❌";
    lines.push(`### ${icon} ${r.name}`);
    lines.push(`- **Duration:** ${r.durationMs.toFixed(0)}ms`);
    if (r.metric !== undefined) lines.push(`- **Metric:** ${r.metric.toFixed(1)} ${r.unit}`);
    lines.push(`- **Target:** ${r.target}`);
    if (r.details) lines.push(`- **Details:** ${r.details}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Main ───────────────────────────────────────────────────

export async function runBenchmarks(): Promise<BenchmarkReport> {
  console.log("🏃 Running Pi-Memory benchmarks...\n");

  const results: BenchmarkResult[] = [];

  // 1. Query latency benchmarks
  console.log("Benchmarking query latency...");
  results.push(await benchmarkQueryLatency(50));
  results.push(await benchmarkQueryLatency(100));

  // 2. Memory injection
  console.log("Benchmarking memory injection...");
  results.push(await benchmarkMemoryInjection(50));
  results.push(await benchmarkMemoryInjection(100));

  // 3. DB size
  console.log("Benchmarking DB size...");
  results.push(await benchmarkDbSize(50));
  results.push(await benchmarkDbSize(100));

  // 4. Lint speed
  console.log("Benchmarking lint speed...");
  results.push(await benchmarkLintSpeed(50));
  results.push(await benchmarkLintSpeed(100));

  // 5. Scaling benchmarks
  console.log("Benchmarking search scaling...");
  const scalingResults = await benchmarkHybridSearchScaling();
  results.push(...scalingResults);

  const passed = results.filter((r) => r.passed).length;
  const report: BenchmarkReport = {
    timestamp: nowMs(),
    results,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
    },
    markdown: "",
  };

  report.markdown = buildMarkdownReport(report);
  return report;
}

export function writeBenchmarkReport(report: BenchmarkReport): string {
  const config = loadConfig();
  const reportDir = join(config.vaultPath, "global-wiki", "benchmarks");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `benchmark-${new Date(report.timestamp).toISOString().slice(0, 10)}.md`);
  writeFileSync(reportPath, report.markdown);
  return reportPath;
}

// CLI entrypoint
if (import.meta.url === process.argv[1] || process.argv[1]?.endsWith("benchmark.ts")) {
  runBenchmarks().then((report) => {
    console.log("\n" + report.markdown);
    const reportPath = writeBenchmarkReport(report);
    console.log(`\n📄 Full report: ${reportPath}`);

    if (report.summary.failed > 0) {
      console.log(`\n⚠️ ${report.summary.failed} benchmark(s) failed`);
      process.exit(1);
    }
    closeDb();
  });
}
