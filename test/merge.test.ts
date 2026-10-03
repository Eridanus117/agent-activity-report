import { expect, test } from "bun:test";
import { mergePrompt, parseItems, reconcile } from "../src/merge.ts";
import type { ActivityEvent } from "../src/types.ts";

const event = (id: string): ActivityEvent => ({
  id, session: "S1", type: "request", statement: `事件 ${id}`, actor: "user", evidence: "evidenced", refs: ["r1"], time: new Date(2026, 0, 15, 10, 0),
});
const events = [event("e1"), event("e2"), event("e3")];
const item = (o: object) => JSON.stringify({ title: "事项", summary: "小结", event_ids: ["e1"], open: [], ...o });

test("the merge prompt lists every event by id", () => {
  const p = mergePrompt("2026-01-15", events, new Map([["S1", "标题"]]));
  expect(p.startsWith("任务：归并事项")).toBe(true);
  for (const e of events) expect(p).toContain(`${e.id} |`);
});

test("an unknown event id is rejected and the rest of the item is kept", () => {
  const r = parseItems(item({ event_ids: ["e1", "e42"] }), new Set(["e1", "e2", "e3"]));
  expect(r.items[0]!.eventIds).toEqual(["e1"]);
  expect(r.rejected[0]!.reason).toContain("e42");
});

test("a malformed item line loses only that line", () => {
  const r = parseItems([item({}), "{broken", item({ title: "另一项", event_ids: ["e2"] })].join("\n"), new Set(["e1", "e2"]));
  expect(r.items.map((i) => i.title)).toEqual(["事项", "另一项"]);
  expect(r.rejected.length).toBe(1);
});

test("events left out by the model are found as unmerged", () => {
  const { items } = parseItems(item({ event_ids: ["e1", "e2"] }), new Set(["e1", "e2", "e3"]));
  const r = reconcile(items, events);
  expect(r.orphans.map((e) => e.id)).toEqual(["e3"]);
});

test("an event placed in two items stays in the first and is counted", () => {
  const text = [item({ title: "甲", event_ids: ["e1", "e2"] }), item({ title: "乙", event_ids: ["e2", "e3"] })].join("\n");
  const { items } = parseItems(text, new Set(["e1", "e2", "e3"]));
  const r = reconcile(items, events);
  expect(r.items.map((i) => i.eventIds)).toEqual([["e1", "e2"], ["e3"]]);
  expect(r.duplicates).toBe(1);
  expect(r.orphans).toEqual([]);
});

test("an item left with no events is dropped", () => {
  const { items } = parseItems(item({ event_ids: ["e9"] }), new Set(["e1"]));
  expect(reconcile(items, [event("e1")]).items).toEqual([]);
});
