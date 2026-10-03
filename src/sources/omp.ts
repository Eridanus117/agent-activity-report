// omp source adapter: the only module that knows the omp session record format.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep, toNamespacedPath } from "node:path";
import type { Kind, Limits, LocateResult, ReadResult, SourceRecord } from "../types.ts";

export const SOURCE = "omp";

export function defaultRoot(home = homedir()): string {
  return join(home, ".omp", "agent", "sessions");
}

// toNamespacedPath lets Windows open paths longer than 260 characters; it is a no-op elsewhere.
const lp = toNamespacedPath;

export function locate(root: string): LocateResult {
  const out: LocateResult = { root, exists: existsSync(lp(root)), files: [], errors: [] };
  if (!out.exists) return out;
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(lp(dir), { withFileTypes: true });
    } catch (e) {
      out.errors.push({ path: toRel(root, dir), error: errorText(e) });
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".jsonl")) out.files.push(path);
    }
  };
  walk(root);
  out.files.sort();
  return out;
}

export function read(root: string, file: string, limits: Limits): ReadResult {
  const rel = toRel(root, file);
  const parts = rel.split("/");
  // <cwd dir>/<session>.jsonl is a main session; anything deeper belongs to that session's subagents.
  const session = `${parts[0]}/${(parts[1] ?? "").replace(/\.jsonl$/, "")}`;
  const subagent = parts.length > 2;
  const result: ReadResult = { file: rel, session, records: [], parsed: 0, badLines: 0 };

  let raw: string;
  try {
    raw = readFileSync(lp(file), "utf8");
    result.mtimeMs = statSync(lp(file)).mtimeMs;
  } catch (e) {
    result.error = errorText(e);
    return result;
  }

  const rows: { o: any; line: number }[] = [];
  raw.split("\n").forEach((text, i) => {
    if (!text.trim()) return;
    try {
      const o = JSON.parse(text);
      if (o && typeof o === "object" && !Array.isArray(o)) rows.push({ o, line: i + 1 });
      else result.badLines++;
    } catch {
      result.badLines++;
    }
  });
  result.parsed = rows.length;

  // A tool result is a separate record; calls need it to know whether they succeeded.
  const results = new Map<string, any>();
  for (const { o } of rows) {
    if (o.message?.role === "toolResult" && typeof o.message.toolCallId === "string") results.set(o.message.toolCallId, o.message);
  }

  for (const { o, line } of rows) {
    if (o.type === "session" && !subagent && typeof o.title === "string" && !result.title) result.title = o.title;
    const timestamp = parseTime(o.timestamp);
    const push = (kind: Kind, text: string, rawType: string, toolOk?: boolean) => {
      const rec: SourceRecord = { source: SOURCE, session, file: rel, line, subagent, kind, text, rawType };
      if (typeof o.id === "string") rec.id = o.id;
      if (timestamp) rec.timestamp = timestamp;
      if (toolOk !== undefined) rec.toolOk = toolOk;
      result.records.push(rec);
    };
    translate(o, subagent, results, limits, push);
  }
  return result;
}

type Push = (kind: Kind, text: string, rawType: string, toolOk?: boolean) => void;

function translate(o: any, subagent: boolean, results: Map<string, any>, limits: Limits, push: Push): void {
  const type = String(o.type);
  const m = o.message;

  if (type === "session_init") {
    push("subagent_task", `(${o.agent ?? ""}) ${cap(String(o.task ?? ""), limits.subagentTask)}`, type);
  } else if (type === "message" && m?.role === "user") {
    // What a subagent receives is its parent agent's instruction, not something the user typed.
    if (subagent) push("subagent_task", cap(textOf(m.content), limits.subagentTask), "message:user");
    else push("user", textOf(m.content), "message:user");
  } else if (type === "message" && m?.role === "assistant") {
    let any = false;
    for (const block of Array.isArray(m.content) ? m.content : []) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        push("assistant", block.text, "message:assistant");
        any = true;
      } else if (block?.type === "toolCall") {
        toolCall(block, results.get(block.id), limits, push);
        any = true;
      }
    }
    if (m.stopReason === "error" || m.stopReason === "aborted") {
      push("stop", `assistant ${m.stopReason} ${cap(String(m.errorMessage ?? ""), limits.stopMessage)}`.trim(), "message:assistant");
      any = true;
    }
    if (!any) push("skipped", "", "message:assistant:thinking_only");
  } else if (type === "message" && m?.role === "toolResult") {
    push("skipped", "", "message:toolResult");
  } else if (type === "custom" && o.customType === "user_todo_edit") {
    push("todo_edit", cap(JSON.stringify(o.data ?? {}), limits.todoEdit), "custom:user_todo_edit");
  } else if (type === "custom" && o.customType === "session_exit") {
    push("stop", `session exit ${o.data?.kind ?? ""} ${cap(String(o.data?.reason ?? ""), limits.stopMessage)}`.trim(), "custom:session_exit");
  } else if (type === "compaction") {
    push("marker", "context compacted (summary not included)", type);
  } else if (type === "model_usage" && o.errorMessage) {
    push("stop", `model error ${cap(String(o.errorMessage), limits.stopMessage)}`, type);
  } else {
    const detail = type === "custom" ? `:${o.customType}` : type === "message" ? `:${m?.role}` : "";
    push("skipped", "", `${type}${detail}`);
  }
}

function toolCall(block: any, result: any, limits: Limits, push: Push): void {
  const name = String(block.name);
  const status = !result ? "NO_RESULT" : result.isError ? "ERROR" : "ok";
  const intent = block.intent ? ` (${cap(oneLine(String(block.intent)), limits.intent)})` : "";
  let text = `${name}${intent}: ${toolTarget(name, block.arguments, limits)} -> ${status}`;
  if (status === "ERROR") {
    push("tool_error", `${text}\n    ERROR_OUTPUT: ${headTail(textOf(result.content), limits.errorHeadTail)}`, "message:assistant");
  } else if (name === "ask" && result) {
    text += `\n    ANSWER: ${cap(textOf(result.content), limits.ask)}`;
    push("ask", text, "message:assistant");
  } else {
    push("tool", text, "message:assistant", status === "ok");
  }
}

function toolTarget(name: string, args: any, limits: Limits): string {
  if (!args || typeof args !== "object") return "";
  switch (name) {
    case "read":
    case "write":
    case "glob":
      return String(args.path ?? "");
    case "grep":
      return `${args.pattern ?? ""} in ${args.path ?? ""}`;
    case "bash":
      return cap(oneLine(String(args.command ?? "")), limits.command);
    case "eval":
      return cap(oneLine(String(args.title ?? args.code ?? "")), limits.command);
    case "edit":
      return cap(oneLine(String(args.input ?? "")), limits.command);
    case "web_search":
      return cap(String(args.query ?? ""), limits.command);
    case "todo":
      return cap(JSON.stringify(args), limits.todo);
    case "ask":
      return cap(JSON.stringify(args.questions ?? args), limits.ask);
    case "task":
      return cap(JSON.stringify(args.tasks ?? args), limits.subagentTask);
    default:
      return cap(JSON.stringify(args), limits.other);
  }
}

function parseTime(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("");
}

const toRel = (root: string, path: string) => relative(root, path).split(sep).join("/");
const errorText = (e: unknown) => String((e as { code?: string })?.code ?? e);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const cap = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}…(+${s.length - n})`);
const headTail = (s: string, n: number) =>
  s.length <= 2 * n ? s : `${s.slice(0, n)}\n…(${s.length - 2 * n} chars omitted)…\n${s.slice(-n)}`;
