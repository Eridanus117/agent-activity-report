// Synthetic omp-shaped session records, built from scratch for tests.
// Nothing here is derived from real sessions.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, toNamespacedPath } from "node:path";
import type { ModelRunner, SourceRecord } from "../src/types.ts";

export function tmpDir(prefix = "aar-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** ISO timestamp for a local wall-clock time, so day-boundary tests hold in any timezone. */
export function localIso(y: number, mo: number, d: number, h = 12, mi = 0, s = 0, ms = 0): string {
  return new Date(y, mo - 1, d, h, mi, s, ms).toISOString();
}

/** Writes one JSON object per line. Strings are written verbatim, to produce malformed lines. */
export function writeJsonl(path: string, rows: (object | string)[]): void {
  mkdirSync(toNamespacedPath(dirname(path)), { recursive: true });
  const body = rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n");
  writeFileSync(toNamespacedPath(path), `${body}\n`);
}

let seq = 0;
const nextId = () => `id${++seq}`;

export const omp = {
  title: (title: string) => ({ type: "title", v: 1, title, updatedAt: 0 }),
  session: (ts: string, title: string) => ({ type: "session", id: nextId(), timestamp: ts, title, cwd: "/work/demo", version: "1" }),
  user: (ts: string, text: string, id = nextId()) => ({
    type: "message", id, timestamp: ts, message: { role: "user", content: [{ type: "text", text }] },
  }),
  assistant: (ts: string, blocks: object[], extra: object = {}, id = nextId()) => ({
    type: "message", id, timestamp: ts, message: { role: "assistant", content: blocks, ...extra },
  }),
  text: (text: string) => ({ type: "text", text }),
  thinking: (text: string) => ({ type: "thinking", thinking: text }),
  call: (callId: string, name: string, args: object, intent?: string) => ({ type: "toolCall", id: callId, name, arguments: args, intent }),
  result: (ts: string, callId: string, text: string, isError = false) => ({
    type: "message", id: nextId(), timestamp: ts,
    message: { role: "toolResult", toolCallId: callId, content: [{ type: "text", text }], isError },
  }),
  custom: (ts: string, customType: string, data: object) => ({ type: "custom", id: nextId(), timestamp: ts, customType, data }),
  compaction: (ts: string, summary: string) => ({ type: "compaction", id: nextId(), timestamp: ts, summary }),
  sessionInit: (ts: string, agent: string, task: string) => ({ type: "session_init", id: nextId(), timestamp: ts, agent, task }),
  modelUsage: (ts: string, errorMessage?: string) => ({ type: "model_usage", id: nextId(), timestamp: ts, errorMessage }),
};

export function record(partial: Partial<SourceRecord> & Pick<SourceRecord, "kind">): SourceRecord {
  return {
    source: "omp",
    session: "proj/s1",
    file: "proj/s1.jsonl",
    line: 1,
    subagent: false,
    text: "",
    rawType: "message",
    timestamp: new Date(2026, 0, 15, 12, 0),
    ...partial,
  };
}

/**
 * Stand-in for the model. Answers the three prompt kinds from the prompt text alone:
 * one request event per USER line, one completed event per successful TOOL line,
 * a single item holding every event, and a fixed overview.
 */
export function fakeRunner(log: string[] = []): ModelRunner {
  return async (prompt) => {
    log.push(prompt);
    let text = "";
    if (prompt.startsWith("任务：抽取事件")) {
      const out: string[] = [];
      for (const m of prompt.matchAll(/^\[(r\d+)\] \d\d:\d\d USER: (.*)$/gm)) {
        out.push(JSON.stringify({ type: "request", statement: `用户要求：${m[2]}`, actor: "user", evidence: "evidenced", refs: [m[1]] }));
      }
      for (const m of prompt.matchAll(/^\[(r\d+)\] \d\d:\d\d TOOL: (.*) -> ok$/gm)) {
        out.push(JSON.stringify({ type: "completed", statement: `完成：${m[2]}`, actor: "agent", evidence: "evidenced", refs: [m[1]] }));
      }
      text = out.length ? out.join("\n") : JSON.stringify({ none: true });
    } else if (prompt.startsWith("任务：归并事项")) {
      const ids = [...prompt.matchAll(/^(e\d+) \|/gm)].map((m) => m[1]);
      text = JSON.stringify({ title: "合成事项", summary: "合成小结", event_ids: ids, open: [] });
    } else if (prompt.startsWith("任务：写概览")) {
      text = "合成概览。";
    }
    return { ok: true, text, ms: 1, attempts: 1, cached: false };
  };
}
