import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { locate, read } from "../src/sources/omp.ts";
import { DEFAULT_LIMITS } from "../src/types.ts";
import { localIso, omp, tmpDir, writeJsonl } from "./helpers.ts";

const T = localIso(2026, 1, 15, 10, 0);

function oneFile(rows: (object | string)[]) {
  const root = tmpDir();
  const file = join(root, "proj", "s1.jsonl");
  writeJsonl(file, rows);
  return { root, file };
}

describe("omp locate", () => {
  test("finds main and nested subagent files", () => {
    const root = tmpDir();
    writeJsonl(join(root, "proj", "s1.jsonl"), [omp.user(T, "a")]);
    writeJsonl(join(root, "proj", "s1", "sub1.jsonl"), [omp.user(T, "b")]);
    writeJsonl(join(root, "proj", "s1", "sub1", "deep.jsonl"), [omp.user(T, "c")]);
    const found = locate(root);
    expect(found.exists).toBe(true);
    expect(found.files.length).toBe(3);
  });

  test("a missing root is reported as absent, not as an error", () => {
    const found = locate(join(tmpDir(), "nope"));
    expect(found.exists).toBe(false);
    expect(found.files).toEqual([]);
    expect(found.errors).toEqual([]);
  });
});

describe("omp read", () => {
  test("maps user and assistant text to full-text records with file and line", () => {
    const { root, file } = oneFile([omp.session(T, "标题"), omp.user(T, "请修复登录"), omp.assistant(T, [omp.text("好的")])]);
    const r = read(root, file, DEFAULT_LIMITS);
    expect(r.title).toBe("标题");
    expect(r.session).toBe("proj/s1");
    const user = r.records.find((x) => x.kind === "user")!;
    expect(user.text).toBe("请修复登录");
    expect(user.file).toBe("proj/s1.jsonl");
    expect(user.line).toBe(2);
    expect(r.records.find((x) => x.kind === "assistant")!.text).toBe("好的");
  });

  test("a successful tool call becomes one line without its output", () => {
    const { root, file } = oneFile([
      omp.assistant(T, [omp.call("c1", "bash", { command: "bun test" }, "run tests")]),
      omp.result(T, "c1", "SECRET-OUTPUT 42 pass"),
    ]);
    const r = read(root, file, DEFAULT_LIMITS);
    const tool = r.records.find((x) => x.kind === "tool")!;
    expect(tool.toolOk).toBe(true);
    expect(tool.text).toBe("bash (run tests): bun test -> ok");
    expect(r.records.some((x) => x.text.includes("SECRET-OUTPUT"))).toBe(false);
    expect(r.records.find((x) => x.rawType === "message:toolResult")!.kind).toBe("skipped");
  });

  test("a failing tool call carries the head and tail of its output", () => {
    const long = `HEAD${"x".repeat(1000)}TAIL`;
    const { root, file } = oneFile([omp.assistant(T, [omp.call("c1", "bash", { command: "make" })]), omp.result(T, "c1", long, true)]);
    const rec = read(root, file, DEFAULT_LIMITS).records.find((x) => x.kind === "tool_error")!;
    expect(rec.text).toContain("-> ERROR");
    expect(rec.text).toContain("HEAD");
    expect(rec.text).toContain("TAIL");
    expect(rec.text.length).toBeLessThan(900);
  });

  test("a tool call without a result is not counted as successful", () => {
    const { root, file } = oneFile([omp.assistant(T, [omp.call("c1", "read", { path: "a.ts" })])]);
    const rec = read(root, file, DEFAULT_LIMITS).records.find((x) => x.kind === "tool")!;
    expect(rec.toolOk).toBe(false);
    expect(rec.text).toContain("-> NO_RESULT");
  });

  test("a question to the user keeps the answer", () => {
    const { root, file } = oneFile([
      omp.assistant(T, [omp.call("c1", "ask", { questions: ["用哪个库？"] })]),
      omp.result(T, "c1", "用 A 库"),
    ]);
    const rec = read(root, file, DEFAULT_LIMITS).records.find((x) => x.kind === "ask")!;
    expect(rec.text).toContain("用哪个库？");
    expect(rec.text).toContain("用 A 库");
  });

  test("thinking is not sent and compaction keeps only a marker", () => {
    const { root, file } = oneFile([omp.assistant(T, [omp.thinking("private reasoning")]), omp.compaction(T, "SUMMARY-TEXT")]);
    const r = read(root, file, DEFAULT_LIMITS);
    expect(r.records.some((x) => x.text.includes("private reasoning"))).toBe(false);
    expect(r.records.some((x) => x.text.includes("SUMMARY-TEXT"))).toBe(false);
    expect(r.records.some((x) => x.kind === "marker")).toBe(true);
  });

  test("todo edits, exits, stops and model errors are kept", () => {
    const { root, file } = oneFile([
      omp.custom(T, "user_todo_edit", { phases: ["a"] }),
      omp.custom(T, "session_exit", { kind: "quit", reason: "user" }),
      omp.assistant(T, [], { stopReason: "aborted", errorMessage: "interrupted" }),
      omp.modelUsage(T, "rate limited"),
      omp.modelUsage(T),
    ]);
    const kinds = read(root, file, DEFAULT_LIMITS).records.map((x) => x.kind);
    expect(kinds).toEqual(["todo_edit", "stop", "stop", "stop", "skipped"]);
  });

  test("records without a timestamp are kept as skipped, with no timestamp", () => {
    const { root, file } = oneFile([omp.title("t")]);
    const rec = read(root, file, DEFAULT_LIMITS).records[0]!;
    expect(rec.kind).toBe("skipped");
    expect(rec.timestamp).toBeUndefined();
  });

  test("subagent files belong to the main session and their input is a task, not a user message", () => {
    const root = tmpDir();
    const file = join(root, "proj", "s1", "sub1.jsonl");
    writeJsonl(file, [omp.sessionInit(T, "scout", "查找入口"), omp.user(T, "查找入口"), omp.assistant(T, [omp.text("找到了")])]);
    const r = read(root, file, DEFAULT_LIMITS);
    expect(r.session).toBe("proj/s1");
    expect(r.records.every((x) => x.subagent)).toBe(true);
    expect(r.records.map((x) => x.kind)).toEqual(["subagent_task", "subagent_task", "assistant"]);
  });

  test("malformed lines are counted and the rest is still read", () => {
    const { root, file } = oneFile([omp.user(T, "a"), "{not json", omp.user(T, "b")]);
    const r = read(root, file, DEFAULT_LIMITS);
    expect(r.badLines).toBe(1);
    expect(r.parsed).toBe(2);
    expect(r.records.filter((x) => x.kind === "user").length).toBe(2);
  });

  test("a file that cannot be read yields an error instead of throwing", () => {
    const root = tmpDir();
    const r = read(root, join(root, "proj", "missing.jsonl"), DEFAULT_LIMITS);
    expect(r.error).toBeDefined();
    expect(r.records).toEqual([]);
  });

  test.if(process.platform === "win32")("reads a file whose path is longer than 260 characters", () => {
    const root = tmpDir();
    const file = join(root, "p".repeat(120), `${"s".repeat(120)}.jsonl`);
    writeJsonl(file, [omp.user(T, "long path")]);
    expect(file.length).toBeGreaterThan(260);
    const found = locate(root);
    expect(found.files.length).toBe(1);
    const r = read(root, found.files[0]!, DEFAULT_LIMITS);
    expect(r.error).toBeUndefined();
    expect(r.records[0]!.text).toBe("long path");
  });
});
