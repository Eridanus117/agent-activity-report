import { expect, test } from "bun:test";
import { itemStatus } from "../src/status.ts";
import type { ActivityEvent, EventType, Evidence } from "../src/types.ts";

// Events are given in time order.
const seq = (...steps: [EventType, Evidence?][]): ActivityEvent[] =>
  steps.map(([type, evidence = "evidenced"], i) => ({
    id: `e${i + 1}`, session: "S1", type, statement: "", actor: "agent", evidence, refs: ["r1"], time: new Date(2026, 0, 15, 10, i),
  }));

test("cancelled with nothing completed afterwards is cancelled", () => {
  expect(itemStatus(seq(["request"], ["completed"], ["cancelled"]))).toBe("cancelled");
});

test("completed after a cancellation is done", () => {
  expect(itemStatus(seq(["request"], ["cancelled"], ["completed"]))).toBe("done");
});

test("blocked with nothing completed afterwards is blocked", () => {
  expect(itemStatus(seq(["request"], ["blocked"]))).toBe("blocked");
  expect(itemStatus(seq(["request"], ["blocked"], ["completed"]))).toBe("done");
});

test("an unfinished event keeps the item in progress even after a completion", () => {
  expect(itemStatus(seq(["completed"], ["unfinished"]))).toBe("in_progress");
  expect(itemStatus(seq(["unfinished"], ["completed"]))).toBe("in_progress");
});

test("a failure after the last completion is in progress; a completion after the failure is done", () => {
  expect(itemStatus(seq(["completed"], ["failed"]))).toBe("in_progress");
  expect(itemStatus(seq(["failed"], ["completed"]))).toBe("done");
});

test("a completion with evidence is done", () => {
  expect(itemStatus(seq(["request"], ["completed", "evidenced"]))).toBe("done");
});

test("completions without evidence are self-reported", () => {
  expect(itemStatus(seq(["request"], ["completed", "self_reported"], ["completed", "attempt"]))).toBe("self_reported_done");
});

test("anything else is in progress", () => {
  expect(itemStatus(seq(["request"], ["exploration"], ["decision"]))).toBe("in_progress");
  expect(itemStatus([])).toBe("in_progress");
});
