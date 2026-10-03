import { expect, test } from "bun:test";
import { buildDigest } from "../src/digest.ts";
import { record } from "./helpers.ts";

const at = (h: number, m: number) => new Date(2026, 0, 15, h, m);

test("lines carry a reference, the local time and a label", () => {
  const d = buildDigest([record({ kind: "user", text: "修复登录", timestamp: at(9, 5) })]);
  expect(d.lines[0]!.text).toBe("[r1] 09:05 USER: 修复登录");
  expect(d.refs.get("r1")!.kind).toBe("user");
});

test("skipped records produce no line and no reference", () => {
  const d = buildDigest([record({ kind: "skipped" }), record({ kind: "assistant", text: "好" })]);
  expect(d.lines.length).toBe(1);
  expect(d.refs.size).toBe(1);
});

test("references record where the line came from and whether a tool call succeeded", () => {
  const d = buildDigest([record({ kind: "tool", text: "bash: ls -> ok", toolOk: true, file: "proj/s1.jsonl", line: 7, id: "a" })]);
  const ref = d.refs.get("r1")!;
  expect(ref).toMatchObject({ file: "proj/s1.jsonl", line: 7, id: "a", kind: "tool", toolOk: true });
  expect(d.lines[0]!.text).toBe("[r1] 12:00 TOOL: bash: ls -> ok");
});

test("lines are in time order across main and subagent files, and subagent lines are marked", () => {
  const d = buildDigest([
    record({ kind: "user", text: "first", timestamp: at(9, 0) }),
    record({ kind: "assistant", text: "third", timestamp: at(9, 10) }),
    record({ kind: "assistant", text: "second", timestamp: at(9, 5), subagent: true, file: "proj/s1/sub.jsonl" }),
  ]);
  expect(d.lines.map((l) => l.text)).toEqual([
    "[r1] 09:00 USER: first",
    "[r2] 09:05 SUB ASSISTANT: second",
    "[r3] 09:10 ASSISTANT: third",
  ]);
});
