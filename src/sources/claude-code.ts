// Claude Code source adapter: the only module that knows the Claude Code session record format.
// The mapping follows docs/changes/1/sdd.md and was checked against client versions ~2.1.26x–2.1.28x.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep, toNamespacedPath } from "node:path";
import type { Kind, Limits, LocateResult, ReadResult, SourceRecord } from "../types.ts";

export const SOURCE = "claude-code";

export function defaultRoot(home = homedir()): string {
  return join(home, ".claude", "projects");
}

const lp = toNamespacedPath;

/** Main sessions are <project>/<session>.jsonl; subagents are <project>/<session>/subagents/*.jsonl. */
export function locate(root: string): LocateResult {
  const out: LocateResult = { root, exists: existsSync(lp(root)), files: [], errors: [] };
  if (!out.exists) return out;
  const list = (dir: string) => {
    try {
      return readdirSync(lp(dir), { withFileTypes: true });
    } catch (e) {
      out.errors.push({ path: toRel(root, dir), error: errorText(e) });
      return [];
    }
  };
  for (const project of list(root)) {
    if (!project.isDirectory()) continue;
    const pdir = join(root, project.name);
    for (const entry of list(pdir)) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) out.files.push(join(pdir, entry.name));
      else if (entry.isDirectory()) {
        const sdir = join(pdir, entry.name, "subagents");
        if (!existsSync(lp(sdir))) continue;
        for (const sub of list(sdir)) if (sub.isFile() && sub.name.endsWith(".jsonl")) out.files.push(join(sdir, sub.name));
      }
    }
  }
  out.files.sort();
  return out;
}

export function read(root: string, file: string, limits: Limits): ReadResult {
  const rel = toRel(root, file);
  const parts = rel.split("/");
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

  // Tool results arrive in later user records; calls need them to know whether they succeeded.
  const results = new Map<string, any>();
  for (const { o } of rows) {
    if (o.type !== "user" || !Array.isArray(o.message?.content)) continue;
    for (const b of o.message.content) if (b?.type === "tool_result" && typeof b.tool_use_id === "string") results.set(b.tool_use_id, b);
  }

  for (const { o, line } of rows) {
    if (o.type === "ai-title" && typeof o.aiTitle === "string" && !subagent) result.title = o.aiTitle;
    const timestamp = parseTime(o.timestamp);
    const push = (kind: Kind, text: string, rawType: string, toolOk?: boolean) => {
      const rec: SourceRecord = { source: SOURCE, session, file: rel, line, subagent, kind, text, rawType };
      if (typeof o.uuid === "string") rec.id = o.uuid;
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
  if (type === "user") userRecord(o, subagent, limits, push);
  else if (type === "assistant") assistantRecord(o, results, limits, push);
  else if (type === "attachment" && o.attachment?.type === "queued_command" && o.attachment.commandMode === "prompt" && typeof o.attachment.prompt === "string") {
    // A message the user sent while the agent was working.
    push(subagent ? "subagent_task" : "user", o.attachment.prompt, "attachment:queued_command");
  } else if (type === "pr-link") {
    push("tool", `pr-link: ${o.prRepository ?? ""}#${o.prNumber ?? ""} -> ok`, type, true);
  } else {
    const detail = type === "attachment" ? `:${o.attachment?.type}` : type === "system" ? `:${o.subtype}` : "";
    push("skipped", "", `${type}${detail}`);
  }
}

function userRecord(o: any, subagent: boolean, limits: Limits, push: Push): void {
  const content = o.message?.content;
  if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")) {
    push("skipped", "", "user:tool_result");
    return;
  }
  if (o.isMeta) {
    push("skipped", "", "user:meta");
    return;
  }
  const raw = textOf(content).trim();
  if (raw.startsWith("[Request interrupted")) {
    push("stop", "user interrupted the agent", "user:interrupt");
    return;
  }
  if (raw.startsWith("This session is being continued")) {
    push("marker", "context continued from a summary (summary not included)", "user:continuation");
    return;
  }
  const typed = restoreTyped(raw);
  const origin = o.origin?.kind;
  const human =
    origin === "human" ? !raw.startsWith("<") || typed !== undefined || raw.startsWith("<pasted_content")
    : origin === undefined ? !raw.startsWith("<") || typed !== undefined
    : false;
  if (!human || !raw) {
    push("skipped", "", `user:${origin ?? (raw.startsWith("<") ? "tagged" : "empty")}`);
    return;
  }
  const text = typed ?? raw;
  if (subagent) push("subagent_task", cap(text, limits.subagentTask), "user");
  else push("user", text, "user");
}

/** Slash commands and shell input are stored as client tags; turn them back into what was typed. */
function restoreTyped(raw: string): string | undefined {
  const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(raw)?.[1]?.trim();
  const command = tag("command-name");
  if (command !== undefined) {
    const args = tag("command-args");
    const name = command.startsWith("/") ? command : `/${command}`;
    return args ? `${name} ${args}` : name;
  }
  const bash = tag("bash-input");
  if (bash !== undefined) return `! ${bash}`;
  return undefined;
}

function assistantRecord(o: any, results: Map<string, any>, limits: Limits, push: Push): void {
  const content = o.message?.content;
  const blocks: any[] = Array.isArray(content) ? content : [];
  if (o.isApiErrorMessage) {
    push("stop", `api error ${cap(oneLine(textOf(content)), limits.stopMessage)}`, "assistant:api_error");
    return;
  }
  let any = false;
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
      push("assistant", b.text, "assistant");
      any = true;
    } else if (b?.type === "tool_use") {
      toolCall(b, results.get(b.id), limits, push);
      any = true;
    }
  }
  if (o.isAbortedMidStream) {
    push("stop", "assistant aborted mid-stream", "assistant:aborted");
    any = true;
  }
  if (!any) push("skipped", "", "assistant:thinking_only");
}

function toolCall(block: any, result: any, limits: Limits, push: Push): void {
  const name = String(block.name);
  const input = block.input ?? {};
  const status = !result ? "NO_RESULT" : result.is_error ? "ERROR" : "ok";
  const intent = typeof input.description === "string" && input.description ? ` (${cap(oneLine(input.description), limits.intent)})` : "";
  let text = `${name}${intent}: ${toolTarget(name, input, limits)} -> ${status}`;
  if (status === "ERROR") {
    push("tool_error", `${text}\n    ERROR_OUTPUT: ${headTail(textOf(result.content), limits.errorHeadTail)}`, "assistant");
  } else if (name === "AskUserQuestion" && result) {
    text += `\n    ANSWER: ${cap(textOf(result.content), limits.ask)}`;
    push("ask", text, "assistant");
  } else {
    push("tool", text, "assistant", status === "ok");
  }
}

function toolTarget(name: string, input: any, limits: Limits): string {
  switch (name) {
    case "Bash":
    case "PowerShell":
      return cap(oneLine(String(input.command ?? "")), limits.command);
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return String(input.file_path ?? input.notebook_path ?? "");
    case "Grep":
      return `${input.pattern ?? ""} in ${input.path ?? ""}`;
    case "Glob":
      return String(input.pattern ?? "");
    case "WebFetch":
      return String(input.url ?? "");
    case "WebSearch":
      return cap(String(input.query ?? ""), limits.command);
    case "Agent":
    case "Task":
      return cap(oneLine(String(input.subagent_type ?? "")), limits.command);
    case "Skill":
      return String(input.skill ?? "");
    case "AskUserQuestion":
      return cap(JSON.stringify(input.questions ?? input), limits.ask);
    default:
      return cap(JSON.stringify(input), limits.other);
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
