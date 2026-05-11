import { getDb } from "../db/connection.js";
import { insertSession, insertEvent, updateSession, getMostRecentMemory, getMemoryByPath, updateMemory, searchHybrid } from "../src/db.js";
import { redactSecrets } from "../src/redact.js";
import { buildMemoryInjection, buildProfileInjection } from "../src/inject.js";
import { loadConfig } from "../src/config.js";
import { triggerFlush, triggerCompile } from "../src/background.js";
import { pinMemory } from "../src/tier.js";
import { gitPull } from "../src/git.js";

// Track current session state
let currentSessionId: string | null = null;
let currentProjectPath: string = "";
let eventCount = 0;
let sessionStartTime = 0;

function generateSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getProjectPath(): string {
  return process.cwd();
}

function extractUserText(event: any): string | null {
  const content = event.content;
  if (!content) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => c.text || "").join(" ");
  }
  return null;
}

// ── Hook Factory ─────────────────────────────────────────────

export default function memoryHook(pi: any): void {
  // ── Session Start ──────────────────────────────────────────
  pi.on("session_start", async (_event: any, ctx: any) => {
    currentSessionId = generateSessionId();
    currentProjectPath = getProjectPath();
    sessionStartTime = Date.now();
    eventCount = 0;

    insertSession({
      id: currentSessionId,
      project_path: currentProjectPath,
      start_time: sessionStartTime,
      compiled: 0,
      event_count: 0,
    });

    // Sync pull before starting work (cross-device support)
    const config = loadConfig();
    if (config.git?.enabled) {
      const pullResult = gitPull(config.vaultPath);
      if (pullResult.ok && pullResult.output) {
        ctx?.ui?.notify?.("🔄 Synced latest memories from remote");
      } else if (!pullResult.ok) {
        ctx?.ui?.notify?.(`⚠️ Sync failed: ${pullResult.error || "unknown error"}`, "warn");
      }
    }

    // Inject profile + hot memories
    const injection = buildProfileInjection(currentProjectPath);
    if (injection && ctx?.ui) {
      ctx.ui.setStatus?.("memory", "💡 memories loaded");
    }

    return { context: injection ? [{ role: "system", content: injection }] : undefined };
  });

  // ── Context Mutation (per LLM call) ────────────────────────
  pi.on("context", async (event: any) => {
    const messages = event.messages || [];
    const lastUserMsg = messages.findLast((m: any) => m.role === "user");
    if (!lastUserMsg) return { messages };

    const query = typeof lastUserMsg.content === "string"
      ? lastUserMsg.content
      : lastUserMsg.content?.map((c: any) => c.text || "").join(" ");

    if (!query || query.length < 10) return { messages };

    try {
      const injection = await buildMemoryInjection(query, currentProjectPath);
      if (injection) {
        const enhanced = [
          { role: "system", content: `[memory-context]\n${injection}` },
          ...messages,
        ];
        return { messages: enhanced };
      }
    } catch (err) {
      // Fail silently — memory injection is best-effort
    }

    return { messages };
  });

  // ── Tool Call (pre-execution capture) ──────────────────────
  pi.on("tool_call", async (event: any) => {
    if (!currentSessionId) return;
    eventCount++;

    const redactedInput = event.input ? redactSecrets(JSON.stringify(event.input)) : null;

    insertEvent({
      session_id: currentSessionId,
      event_type: "tool_call",
      timestamp: Date.now(),
      tool_name: event.toolName,
      input_json: redactedInput,
      project_path: currentProjectPath,
    });
  });

  // ── Tool Result (post-execution capture) ───────────────────
  pi.on("tool_result", async (event: any) => {
    if (!currentSessionId) return;

    const content = event.content
      ? event.content.map((c: any) => c.text || "").join(" ")
      : "";
    const redactedOutput = redactSecrets(content);

    insertEvent({
      session_id: currentSessionId,
      event_type: "tool_result",
      timestamp: Date.now(),
      tool_name: event.toolName,
      output_json: redactedOutput ? JSON.stringify({ content: redactedOutput }) : null,
      project_path: currentProjectPath,
    });
  });

  // ── Turn End ───────────────────────────────────────────────
  pi.on("turn_end", async (event: any) => {
    if (!currentSessionId) return;

    insertEvent({
      session_id: currentSessionId,
      event_type: "turn",
      timestamp: Date.now(),
      content: event.content ? JSON.stringify(event.content) : null,
      project_path: currentProjectPath,
    });

    // Natural language pinning detection
    const userText = extractUserText(event);
    if (userText) {
      const pinTriggers = ["pin this", "remember this", "remember that", "pin that"];
      const rememberTrigger = userText.match(/(?:remember|pin)\s+(.{3,60})/i);

      if (pinTriggers.some((t) => userText.toLowerCase().includes(t))) {
        // Store a pin_request event — this marks the session content as explicitly requested
        // The flush script will extract it into a "Pinned Notes" section
        insertEvent({
          session_id: currentSessionId,
          event_type: "pin_request",
          timestamp: Date.now(),
          content: userText,
          project_path: currentProjectPath,
        });

        // Also try to pin the most recent existing memory (if any)
        const recent = getMostRecentMemory(currentProjectPath);
        if (recent) {
          const result = pinMemory(recent.content);
          if (result.wasPinned) {
            updateMemory(recent.path, { content: result.content });
            pi.ui?.notify?.(`📌 Flagged this session for preservation. Pinned "${recent.title}".`, "info");
          } else {
            pi.ui?.notify?.(`📌 Flagged this session for preservation.`, "info");
          }
        } else {
          pi.ui?.notify?.(`📌 Flagged this session for preservation.`, "info");
        }
      } else if (rememberTrigger && rememberTrigger[1]) {
        // "Remember X" — store a pin request with the topic, search and pin existing
        const query = rememberTrigger[1].trim();
        insertEvent({
          session_id: currentSessionId,
          event_type: "pin_request",
          timestamp: Date.now(),
          content: `remember: ${query}`,
          project_path: currentProjectPath,
        });

        try {
          const { generateEmbedding } = await import("../src/embed.js");
          const embedding = await generateEmbedding(query);
          const results = searchHybrid(embedding, query, { limit: 3, projectPath: currentProjectPath });
          if (results.length > 0) {
            const top = results[0];
            const memory = getMemoryByPath(top.path);
            if (memory) {
              const result = pinMemory(memory.content);
              if (result.wasPinned) {
                updateMemory(memory.path, { content: result.content });
                pi.ui?.notify?.(`📌 Flagged for "${query}". Pinned "${memory.title}".`, "info");
              } else {
                pi.ui?.notify?.(`📌 "${memory.title}" already pinned for "${query}".`, "info");
              }
            } else {
              pi.ui?.notify?.(`📌 Flagged for "${query}".`, "info");
            }
          } else {
            pi.ui?.notify?.(`📌 Flagged for "${query}".`, "info");
          }
        } catch {
          // Silently fail
          pi.ui?.notify?.(`📌 Flagged for "${query}".`, "info");
        }
      }
    }
  });

  // ── Session Compacting (emergency flush) ───────────────────
  pi.on("session.compacting", async (_event: any, ctx: any) => {
    if (!currentSessionId) return;

    updateSession(currentSessionId, {
      event_count: eventCount,
    });

    // Emergency: flush this session before context is lost
    triggerFlush();

    ctx.ui?.notify?.(
      `💾 Emergency flush: saving ${eventCount} events from this session before compaction`,
      "info"
    );

    return {
      preserveData: {
        piMemorySessionId: currentSessionId,
        piMemoryEventCount: eventCount,
      },
    };
  });

  // ── Session Shutdown ───────────────────────────────────────
  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    if (!currentSessionId) return;

    const endTime = Date.now();
    const duration = endTime - sessionStartTime;

    updateSession(currentSessionId, {
      end_time: endTime,
      event_count: eventCount,
      summary: `Session lasted ${Math.round(duration / 1000)}s with ${eventCount} events`,
    });

    // Trigger background flush + compile
    const config = loadConfig();

    // Always flush on shutdown (fast, deterministic)
    triggerFlush();

    if (ctx?.ui) {
      ctx.ui.notify?.(`💾 Session saved: ${eventCount} events captured`, "info");
    }

    if (config.compilation.autoTrigger) {
      const db = getDb();
      const pending = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE compiled = 0").get() as { c: number };

      if (pending.c >= config.compilation.autoTriggerAfterSessions) {
        // Compile in background after flush completes
        // Small delay to let flush finish first
        setTimeout(() => triggerCompile(config.compilation.maxSessionsPerCompile), 2000);

        if (ctx?.ui) {
          ctx.ui.notify?.(`📚 Auto-compiling ${pending.c} sessions in background...`);
        }
      }
    }

    currentSessionId = null;
    currentProjectPath = "";
  });

  // ── Slash Commands ─────────────────────────────────────────
  pi.registerCommand?.("memory-search", {
    description: "Search your Pi-Memory knowledge base",
    handler: async (args: string, ctx: any) => {
      const query = args.trim() || "*";
      const projectPath = getProjectPath();
      try {
        const embedding = await generateEmbedding(query);
        const { searchHybrid } = await import("../src/db.js");
        const results = searchHybrid(embedding, query, {
          limit: 10,
          projectPath,
        });

        if (results.length === 0) {
          ctx.ui?.notify?.("No memories found.", "info");
          return;
        }

        const lines = results.map((r, i) => `${i + 1}. [[${r.title}]] (${r.project ?? "global"}) — score: ${r.score.toFixed(3)}`);
        ctx.ui?.notify?.(`Found ${results.length} memories:\n${lines.join("\n")}`, "info");
      } catch (err: any) {
        ctx.ui?.notify?.(`Search error: ${err.message}`, "error");
      }
    },
  });

  pi.registerCommand?.("memory-pin", {
    description: "Pin a memory to prevent automatic tier demotion",
    handler: async (args: string, ctx: any) => {
      const query = args.trim();
      if (!query) {
        // Pin most recent memory
        const recent = getMostRecentMemory(currentProjectPath);
        if (!recent) {
          ctx.ui?.notify?.("No memories to pin.", "warn");
          return;
        }
        const result = pinMemory(recent.content);
        if (result.wasPinned) {
          updateMemory(recent.path, { content: result.content });
          ctx.ui?.notify?.(`📌 Pinned "${recent.title}"`, "info");
        } else {
          ctx.ui?.notify?.(`📌 "${recent.title}" is already pinned`, "info");
        }
        return;
      }

      // Search and pin top match
      try {
        const { generateEmbedding } = await import("../src/embed.js");
        const embedding = await generateEmbedding(query);
        const { searchHybrid } = await import("../src/db.js");
        const results = searchHybrid(embedding, query, { limit: 3, projectPath: currentProjectPath });
        if (results.length === 0) {
          ctx.ui?.notify?.(`No memories found for "${query}"`, "warn");
          return;
        }
        const top = results[0];
        const memory = getMemoryByPath(top.path);
        if (memory) {
          const result = pinMemory(memory.content);
          if (result.wasPinned) {
            updateMemory(memory.path, { content: result.content });
            ctx.ui?.notify?.(`📌 Pinned "${memory.title}"`, "info");
          } else {
            ctx.ui?.notify?.(`📌 "${memory.title}" is already pinned`, "info");
          }
        }
      } catch (err: any) {
        ctx.ui?.notify?.(`Pin error: ${err.message}`, "error");
      }
    },
  });

  pi.registerCommand?.("memory-compile", {
    description: "Trigger the dream phase to compile raw sessions into wiki pages",
    handler: async (_args: string, ctx: any) => {
      triggerCompile();
      ctx.ui?.notify?.("Compiling memories in background...", "info");
    },
  });

  pi.registerCommand?.("memory-lint", {
    description: "Run health checks on your memory vault",
    handler: async (_args: string, ctx: any) => {
      try {
        const { runLint, writeLintReport } = await import("../scripts/lint.js");
        const report = runLint();
        const summary =
          `Pi-Memory Health Report:\n` +
          `• Pages: ${report.summary.totalPages} | Links: ${report.summary.totalLinks}\n` +
          `• Errors: ${report.summary.errors} | Warnings: ${report.summary.warnings} | Infos: ${report.summary.infos}\n` +
          (report.issues.length > 0
            ? `\nTop issues:\n${report.issues.slice(0, 5).map((i) => `${i.severity === "error" ? "❌" : "⚠️"} ${i.check}: ${i.message}`).join("\n")}`
            : "\n✅ Vault is healthy!");

        ctx.ui?.notify?.(summary, report.summary.errors > 0 ? "warn" : "info");

        // Write full report in background
        const reportPath = writeLintReport(report);
        ctx.ui?.notify?.(`📄 Full report: ${reportPath}`, "info");
      } catch (err: any) {
        ctx.ui?.notify?.(`Lint error: ${err.message}`, "error");
      }
    },
  });

  pi.registerCommand?.("memory-status", {
    description: "Show Pi-Memory capture stats",
    handler: async (_args: string, ctx: any) => {
      const db = getDb();
      const sessions = db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number };
      const pending = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE compiled = 0").get() as { c: number };
      const memories = db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number };
      const events = db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number };

      ctx.ui?.notify?.(
        `Pi-Memory Status:\n` +
        `• Sessions: ${sessions.c} (${pending.c} pending compilation)\n` +
        `• Memories: ${memories.c}\n` +
        `• Events: ${events.c}\n` +
        `• Current session: ${currentSessionId ?? "none"}`,
        "info"
      );
    },
  });

  pi.registerCommand?.("memory-benchmark", {
    description: "Run performance benchmarks on Pi-Memory",
    handler: async (_args: string, ctx: any) => {
      try {
        ctx.ui?.notify?.("Running benchmarks... (this may take a minute)", "info");
        const { runBenchmarks } = await import("../scripts/benchmark.js");
        const report = await runBenchmarks();
        const summary =
          `Benchmark Results:\n` +
          `• Total: ${report.summary.total}\n` +
          `• Passed: ${report.summary.passed} ✅\n` +
          `• Failed: ${report.summary.failed} ❌\n` +
          `\nSlowest:\n${report.results.sort((a, b) => b.durationMs - a.durationMs).slice(0, 3).map((r) => `• ${r.name}: ${r.durationMs.toFixed(0)}ms`).join("\n")}`;

        ctx.ui?.notify?.(summary, report.summary.failed > 0 ? "warn" : "info");
      } catch (err: any) {
        ctx.ui?.notify?.(`Benchmark error: ${err.message}`, "error");
      }
    },
  });
}
