import { expect, test } from "bun:test";
import { chunkLines } from "../src/chunk.ts";
import type { DigestLine } from "../src/types.ts";

// Each line costs its text length plus one for the newline.
const line = (kind: DigestLine["kind"], len: number, subagent = false): DigestLine => ({ ref: "r", kind, subagent, text: "x".repeat(len - 1) });

test("content exactly at the limit stays in one chunk; one character more makes two", () => {
  const two = [line("user", 50), line("user", 50)];
  expect(chunkLines(two, 100).length).toBe(1);
  expect(chunkLines([line("user", 50), line("user", 51)], 100).length).toBe(2);
});

test("chunks are cut in front of a main-session user message, keeping its follow-up together", () => {
  const lines = [line("user", 30), line("assistant", 30), line("user", 30), line("tool", 30)];
  const chunks = chunkLines(lines, 100);
  expect(chunks.map((c) => c.map((l) => l.kind))).toEqual([
    ["user", "assistant"],
    ["user", "tool"],
  ]);
});

test("a subagent input does not start a new segment", () => {
  const lines = [line("user", 30), line("subagent_task", 30, true), line("assistant", 30, true), line("user", 30)];
  const chunks = chunkLines(lines, 100);
  expect(chunks.map((c) => c.length)).toEqual([3, 1]);
});

test("a single segment larger than the limit is cut by lines", () => {
  const lines = [line("user", 40), line("assistant", 40), line("assistant", 40), line("assistant", 40)];
  const chunks = chunkLines(lines, 100);
  expect(chunks.map((c) => c.length)).toEqual([2, 2]);
});

test("a single line larger than the limit gets its own chunk and nothing is lost", () => {
  const lines = [line("user", 10), line("assistant", 500), line("assistant", 10)];
  const chunks = chunkLines(lines, 100);
  expect(chunks.flat().length).toBe(3);
  expect(chunks.some((c) => c.length === 1 && c[0]!.text.length === 499)).toBe(true);
});

test("no lines give no chunks", () => {
  expect(chunkLines([], 100)).toEqual([]);
});
