#!/usr/bin/env tsx
/**
 * Flush: Extract key events from raw sessions and write structured daily logs.
 * Supports heuristic (free, fast) or LLM-powered (higher quality) extraction.
 */
import { getDb, closeDb } from "../db/connection.js";
import { getUncompiledSessions, getEventsBySession } from "../src/db.js";
import { loadConfig } from "../src/config.js";
import { callLLM } from "../src/llm.js";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

interface DailyLogEntry {
  time: string;
  sessionId: string;
  events: Array<{
    type: string;
    tool?: string;
    summary: string;
  }>;
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toISOString().slice(11, 16); // HH:MM
}

function summarizeEvent(event: any): string {
  switch (event.event_type) {
    case "tool_call":
      return `Called ${event.tool_name}: ${event.input_json?.slice(0, 100) ?? ""}`;
    case "tool_result":
      return `${event.tool_name} result: ${event.output_json?.slice(0, 100) ?? ""}`;
    case "turn":
      return `Conversation turn`;
    default:
      return `${event.event_type}`;
  }
}

function extractDecisions(events: any[]): string[] {
  const decisions: string[] = [];
  for (const e of events) {
    const content = e.content || e.input_json || e.output_json || "";
    if (/decided|decision|chose|opted for|went with/i.test(content)) {
      decisions.push(content.slice(0, 300));
    }
  }
  return decisions;
}

function extractErrors(events: any[]): string[] {
  const errors: string[] = [];
  for (const e of events) {
    const content = e.output_json || e.content || "";
    if (/error|failed|exception|throw/i.test(content)) {
      errors.push(content.slice(0, 300));
    }
  }
  return errors;
}

function extractFiles(events: any[]): string[] {
  const files = new Set<string>();
  for (const e of events) {
    const content = e.input_json || e.output_json || "";
    const matches = content.match(/[\w\-./]+\.(ts|js|tsx|jsx|json|md|py|go|rs|java)/g);
    if (matches) {
      matches.forEach((f: string) => files.add(f));
    }
  }
  return [...files].slice(0, 20);
}

function formatTranscript(events: any[]): string {
  const lines: string[] = [];
  for (const e of events) {
    const time = formatTime(e.timestamp);
    if (e.event_type === "tool_call") {
      lines.push(`[${time}] Tool: ${e.tool_name}`);
      if (e.input_json) lines.push(`Input: ${e.input_json.slice(0, 500)}`);
    } else if (e.event_type === "tool_result") {
      lines.push(`[${time}] Result: ${e.tool_name}`);
      if (e.output_json) lines.push(`Output: ${e.output_json.slice(0, 500)}`);
    } else if (e.content) {
      lines.push(`[${time}] ${e.event_type}: ${e.content.slice(0, 500)}`);
    }
  }
  return lines.join("\n");
}

async function flushWithLLM(session: any, events: any[], logPath: string): Promise<void> {
  const config = loadConfig();
  const transcript = formatTranscript(events);

  const pinnedNotes = events
    .filter((e: any) => e.event_type === "pin_request" && e.content)
    .map((e: any) => `- ${e.content}`)
    .join("\n");

  const prompt = `You are reviewing a coding session transcript. Extract important knowledge worth preserving.

Transcript:
${transcript}

${pinnedNotes ? `## 📌 Pinned Notes (user explicitly requested preservation)\n${pinnedNotes}\n\n` : ""}Format your response as a structured daily log entry with these sections (only include sections with actual content):

## Context
[One line about what the user was working on]

## Key Exchanges
- [Important Q&A or discussions]

## Decisions Made
- [Any decisions with rationale]

## Lessons Learned
- [Gotchas, patterns, or insights discovered]

## Errors / Gotchas
- [Errors encountered and how they were fixed]

## Files Touched
- [files and what changed]

## Action Items
- [Follow-ups or TODOs mentioned]

If nothing is worth saving, respond with exactly: FLUSH_OK`;

  try {
    const response = await callLLM(prompt, "You are a knowledge extraction assistant. Extract only important, non-obvious information from coding sessions.");
    const content = response.content;

    if (content.includes("FLUSH_OK")) {
      writeFileSync(logPath, `---\nsession_id: ${session.id}\nproject: ${session.project_path}\nllm: true\n---\n\n# Session: ${session.id}\n\nFLUSH_OK - Nothing worth saving\n`);
    } else {
      writeFileSync(logPath, `---\nsession_id: ${session.id}\nproject: ${session.project_path}\nllm: true\ncost: ${response.costUsd?.toFixed(4) ?? "unknown"}\n---\n\n# Session: ${session.id}\n\n${content}\n`);
    }
  } catch (err: any) {
    console.error(`LLM flush failed for ${session.id}: ${err.message}`);
    // Fall back to heuristic
    flushWithHeuristic(session, events, logPath);
  }
}

function extractPinnedNotes(events: any[]): string[] {
  const notes: string[] = [];
  for (const e of events) {
    if (e.event_type === "pin_request" && e.content) {
      notes.push(e.content);
    }
  }
  return notes;
}

function flushWithHeuristic(session: any, events: any[], logPath: string): void {
  const lines: string[] = [];

  lines.push(`---`);
  lines.push(`session_id: ${session.id}`);
  lines.push(`project: ${session.project_path}`);
  lines.push(`start_time: ${new Date(session.start_time).toISOString()}`);
  lines.push(`end_time: ${session.end_time ? new Date(session.end_time).toISOString() : "ongoing"}`);
  lines.push(`event_count: ${events.length}`);
  lines.push(`---`);
  lines.push("");
  lines.push(`# Session Log: ${session.id}`);
  lines.push("");

  // Pinned notes get highest priority — user explicitly requested these
  const pinnedNotes = extractPinnedNotes(events);
  if (pinnedNotes.length > 0) {
    lines.push("## 📌 Pinned Notes (user explicitly requested preservation)");
    pinnedNotes.forEach((n) => lines.push(`- ${n}`));
    lines.push("");
  }

  const decisions = extractDecisions(events);
  const errors = extractErrors(events);
  const files = extractFiles(events);

  if (decisions.length > 0) {
    lines.push("## Decisions");
    decisions.forEach((d) => lines.push(`- ${d}`));
    lines.push("");
  }

  if (errors.length > 0) {
    lines.push("## Errors / Issues");
    errors.forEach((e) => lines.push(`- ${e}`));
    lines.push("");
  }

  if (files.length > 0) {
    lines.push("## Files Touched");
    files.forEach((f) => lines.push(`- \`${f}\``));
    lines.push("");
  }

  lines.push("## Events");
  for (const event of events) {
    const time = formatTime(event.timestamp);
    lines.push(`### [${time}] ${event.event_type}${event.tool_name ? ` | ${event.tool_name}` : ""}`);
    lines.push(summarizeEvent(event));
    lines.push("");
  }

  writeFileSync(logPath, lines.join("\n"));
}

export async function flushSessions(sessionLimit = 50): Promise<{ flushed: number; logPath?: string }> {
  const db = getDb();
  const sessions = getUncompiledSessions(sessionLimit);

  if (sessions.length === 0) {
    console.log("No uncompiled sessions to flush.");
    return { flushed: 0 };
  }

  const config = loadConfig();
  const useLLM = config.flush?.mode === "llm" && config.llm;
  const today = new Date().toISOString().slice(0, 10);
  const rawDir = join(config.vaultPath, "raw-sessions", today);
  mkdirSync(rawDir, { recursive: true });

  let totalEvents = 0;

  for (const session of sessions) {
    const events = getEventsBySession(session.id);
    totalEvents += events.length;

    const logPath = join(rawDir, `${session.id}.md`);

    if (useLLM) {
      await flushWithLLM(session, events, logPath);
    } else {
      flushWithHeuristic(session, events, logPath);
    }

    console.log(`Flushed session ${session.id} (${events.length} events) → ${logPath}`);
  }

  console.log(`Flushed ${sessions.length} sessions with ${totalEvents} total events.`);
  return { flushed: sessions.length, logPath: rawDir };
}

// CLI entrypoint
if (import.meta.url === process.argv[1] || process.argv[1]?.endsWith("flush.ts")) {
  const limit = process.argv[2] ? parseInt(process.argv[2], 10) : 50;
  flushSessions(limit).then(() => closeDb());
}
