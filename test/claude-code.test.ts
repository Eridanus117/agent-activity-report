import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { locate, read } from "../src/sources/claude-code.ts";
import { DEFAULT_LIMITS, type SourceRecord } from "../src/types.ts";
import { cc, localIso, tmpDir, writeJsonl } from "./helpers.ts";

const T = localIso(2026, 1, 15, 10, 0);

function oneFile(rows: (object | string)[]) {
  const root = tmpDir();
  const file = join(root, "proj", "sess1.jsonl");
  writeJsonl(file, rows);
  return read(root, file, DEFAULT_LIMITS);
}
const kinds = (rs: SourceRecord[]) => rs.map((r) => r.kind);
const users = (rs: SourceRecord[]) => rs.filter((r) => r.kind === "user").map((r) => r.text);

describe("claude-code locate", () => {
  test("finds main session files and subagent files, nothing else", () => {
    const root = tmpDir();
    writeJsonl(join(root, "proj", "sess1.jsonl"), [cc.user(T, "a")]);
    writeJsonl(join(root, "proj", "sess1", "subagents", "agent-1.jsonl"), [cc.user(T, "b")]);
    writeJsonl(join(root, "proj", "sess1", "tool-results", "x.jsonl"), [cc.user(T, "c")]);
    const found = locate(root);
    expect(found.files.map((f) => f.slice(root.length + 1).replaceAll("\\", "/")).sort()).toEqual([
      "proj/sess1.jsonl",
      "proj/sess1/subagents/agent-1.jsonl",
    ]);
  });

  test("a missing root is reported as absent", () => {
    expect(locate(join(tmpDir(), "none")).exists).toBe(false);
  });
});

describe("claude-code read: what counts as a user message", () => {
  test("typed input is a user message, with session key, file and line", () => {
    const r = oneFile([cc.aiTitle("修登录"), cc.user(T, "请修复登录")]);
    expect(r.session).toBe("proj/sess1");
    expect(r.title).toBe("修登录");
    const u = r.records.find((x) => x.kind === "user")!;
    expect(u).toMatchObject({ text: "请修复登录", file: "proj/sess1.jsonl", line: 2, source: "claude-code" });
  });

  test("text blocks count the same as string content", () => {
    expect(users(oneFile([cc.user(T, [{ type: "text", text: "块形式" }])]).records)).toEqual(["块形式"]);
  });

  test("input without an origin field (older clients) is a user message unless it is a client tag", () => {
    const r = oneFile([cc.user(T, "旧版输入", {}), cc.user(T, "<local-command-stdout>ok</local-command-stdout>", {})]);
    expect(users(r.records)).toEqual(["旧版输入"]);
  });

  test("task notifications, meta records and command output are not user messages", () => {
    const r = oneFile([
      cc.user(T, "<task-notification>done</task-notification>", { origin: { kind: "task-notification" } }),
      cc.user(T, "Base directory for this skill: …", { isMeta: true }),
      cc.user(T, "<local-command-caveat>Caveat</local-command-caveat>", { isMeta: true }),
      cc.user(T, "<local-command-stdout>Set model</local-command-stdout>", { origin: { kind: "human" } }),
    ]);
    expect(users(r.records)).toEqual([]);
    expect(kinds(r.records)).toEqual(["skipped", "skipped", "skipped", "skipped"]);
  });

  test("a non-human origin excludes the record even when its text looks like plain input", () => {
    const r = oneFile([cc.user(T, "background task finished", { origin: { kind: "task-notification" } }), cc.user(T, "协调者消息", { origin: { kind: "coordinator" } })]);
    expect(users(r.records)).toEqual([]);
  });

  test("slash commands and shell input are restored to what the user typed", () => {
    const r = oneFile([
      cc.user(T, "<command-message>model</command-message>\n<command-name>/model</command-name>\n<command-args>opus</command-args>"),
      cc.user(T, "<bash-input>git status</bash-input>"),
    ]);
    expect(users(r.records)).toEqual(["/model opus", "! git status"]);
  });

  test("an interruption is a stop and a continuation summary is only a marker", () => {
    const r = oneFile([cc.user(T, "[Request interrupted by user]", {}), cc.user(T, "This session is being continued from a previous conversation… SUMMARY", {})]);
    expect(kinds(r.records)).toEqual(["stop", "marker"]);
    expect(r.records.some((x) => x.text.includes("SUMMARY"))).toBe(false);
  });

  test("a message sent while the agent was working arrives as a queued_command attachment", () => {
    const r = oneFile([
      cc.attachment(T, { type: "queued_command", prompt: "顺便改一下标题", commandMode: "prompt", origin: { kind: "human" } }),
      cc.attachment(T, { type: "queued_command", prompt: "<task-notification>x</task-notification>", commandMode: "task-notification" }),
      cc.attachment(T, { type: "hook_success" }),
    ]);
    expect(users(r.records)).toEqual(["顺便改一下标题"]);
    expect(kinds(r.records)).toEqual(["user", "skipped", "skipped"]);
  });

  test("subagent files belong to the main session and their input is a task", () => {
    const root = tmpDir();
    const file = join(root, "proj", "sess1", "subagents", "agent-1.jsonl");
    writeJsonl(file, [cc.user(T, "查找入口", { isSidechain: true }), cc.assistant(T, [cc.text("在 a.ts")])]);
    const r = read(root, file, DEFAULT_LIMITS);
    expect(r.session).toBe("proj/sess1");
    expect(r.records.every((x) => x.subagent)).toBe(true);
    expect(kinds(r.records)).toEqual(["subagent_task", "assistant"]);
  });
});

describe("claude-code read: agent activity", () => {
  test("a tool call is one line; its result decides success and its output is not sent", () => {
    const r = oneFile([
      cc.assistant(T, [cc.toolUse("t1", "Bash", { command: "bun test", description: "Run tests" })]),
      cc.toolResult(T, "t1", "SECRET 70 pass"),
    ]);
    const tool = r.records.find((x) => x.kind === "tool")!;
    expect(tool.text).toBe("Bash (Run tests): bun test -> ok");
    expect(tool.toolOk).toBe(true);
    expect(r.records.some((x) => x.text.includes("SECRET"))).toBe(false);
  });

  test("a failing tool call carries the head and tail of its output", () => {
    const r = oneFile([cc.assistant(T, [cc.toolUse("t1", "Read", { file_path: "a.ts" })]), cc.toolResult(T, "t1", "File does not exist", true)]);
    const rec = r.records.find((x) => x.kind === "tool_error")!;
    expect(rec.text).toContain("Read: a.ts -> ERROR");
    expect(rec.text).toContain("File does not exist");
  });

  test("a call without a result is not successful", () => {
    const rec = oneFile([cc.assistant(T, [cc.toolUse("t1", "Edit", { file_path: "a.ts" })])]).records.find((x) => x.kind === "tool")!;
    expect(rec.toolOk).toBe(false);
    expect(rec.text).toContain("-> NO_RESULT");
  });

  test("a question to the user keeps the answer", () => {
    const r = oneFile([
      cc.assistant(T, [cc.toolUse("t1", "AskUserQuestion", { questions: [{ question: "用哪个库？" }] })]),
      cc.toolResult(T, "t1", "用 A 库"),
    ]);
    const ask = r.records.find((x) => x.kind === "ask")!;
    expect(ask.text).toContain("用哪个库？");
    expect(ask.text).toContain("用 A 库");
  });

  test("assistant text is kept, thinking is not, and API errors are stops", () => {
    const r = oneFile([
      cc.assistant(T, [cc.thinking("private")]),
      cc.assistant(T, [cc.text("改好了")]),
      cc.assistant(T, [cc.text("API Error: overloaded")], { isApiErrorMessage: true }),
    ]);
    expect(kinds(r.records)).toEqual(["skipped", "assistant", "stop"]);
    expect(r.records.some((x) => x.text.includes("private"))).toBe(false);
  });

  test("a PR link is a successful tool line", () => {
    const rec = oneFile([cc.prLink(T, "owner/repo", 12)]).records[0]!;
    expect(rec).toMatchObject({ kind: "tool", toolOk: true });
    expect(rec.text).toContain("owner/repo#12");
  });

  test("system records and records without a timestamp are skipped", () => {
    const r = oneFile([cc.system(T, "turn_duration"), cc.aiTitle("t")]);
    expect(kinds(r.records)).toEqual(["skipped", "skipped"]);
    expect(r.records[1]!.timestamp).toBeUndefined();
  });

  test("malformed lines are counted and the rest is read; an unreadable file yields an error", () => {
    const r = oneFile([cc.user(T, "a"), "{oops", cc.user(T, "b")]);
    expect(r.badLines).toBe(1);
    expect(users(r.records)).toEqual(["a", "b"]);
    const root = tmpDir();
    expect(read(root, join(root, "proj", "none.jsonl"), DEFAULT_LIMITS).error).toBeDefined();
  });

  test("the record uuid is the id used for de-duplication", () => {
    const rec = oneFile([cc.user(T, "a", { origin: { kind: "human" } }, "fixed-uuid")]).records[0]!;
    expect(rec.id).toBe("fixed-uuid");
  });
});
