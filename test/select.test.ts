import { expect, test } from "bun:test";
import { localDay, selectDay } from "../src/select.ts";
import { record } from "./helpers.ts";

test("23:59:59.999 local belongs to the day and 00:00:00.000 to the next", () => {
  const last = record({ kind: "user", line: 1, timestamp: new Date(2026, 0, 15, 23, 59, 59, 999) });
  const first = record({ kind: "user", line: 2, timestamp: new Date(2026, 0, 16, 0, 0, 0, 0) });
  const picked = selectDay([last, first], "2026-01-15", new Map());
  expect(picked.inDay).toEqual([last]);
  expect(selectDay([last, first], "2026-01-16", new Map()).inDay).toEqual([first]);
});

test("localDay formats the local calendar date", () => {
  expect(localDay(new Date(2026, 0, 5, 0, 0))).toBe("2026-01-05");
});

test("records without a timestamp are counted, not assigned to any day", () => {
  const picked = selectDay([record({ kind: "skipped", timestamp: undefined })], "2026-01-15", new Map());
  expect(picked.inDay).toEqual([]);
  expect(picked.noTimestamp).toBe(1);
});

test("a record id seen again at another location is dropped and counted", () => {
  const seen = new Map<string, string>();
  const a = record({ kind: "user", id: "x1", file: "proj/s1.jsonl", line: 3 });
  const copy = record({ kind: "user", id: "x1", file: "proj/s2.jsonl", line: 9 });
  const first = selectDay([a], "2026-01-15", seen);
  const second = selectDay([copy], "2026-01-15", seen);
  expect(first.inDay.length).toBe(1);
  expect(second.inDay).toEqual([]);
  expect(second.duplicates).toBe(1);
});

test("several records from the same raw line are not duplicates of each other", () => {
  const a = record({ kind: "assistant", id: "x1", line: 3 });
  const b = record({ kind: "tool", id: "x1", line: 3 });
  const picked = selectDay([a, b], "2026-01-15", new Map());
  expect(picked.inDay.length).toBe(2);
  expect(picked.duplicates).toBe(0);
});
