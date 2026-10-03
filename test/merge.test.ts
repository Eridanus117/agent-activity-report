import { describe, expect, test } from "bun:test";
import { fillPrompt, mergePrompt, parseFill, parseItems, reconcile } from "../src/merge.ts";
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

describe("fill-in pass for events the merge left out", () => {
  const existing = [
    { title: "修复登录", summary: "已修复", eventIds: ["e1"], open: [] },
    { title: "更新文档", summary: "进行中", eventIds: ["e2"], open: [] },
  ];

  test("the prompt lists the existing items by number and only the left-out events", () => {
    const p = fillPrompt("2026-01-15", [event("e3")], existing, new Map([["S1", "标题"]]));
    expect(p.startsWith("任务：补充归并")).toBe(true);
    expect(p).toContain("1. 修复登录");
    expect(p).toContain("2. 更新文档");
    expect(p).toContain("e3 |");
    expect(p).not.toContain("e1 |");
  });

  test("events can be added to an existing item by number or form a new item", () => {
    const text = [
      JSON.stringify({ item: 2, event_ids: ["e3"] }),
      JSON.stringify({ title: "新事项", summary: "小结", event_ids: ["e4"], open: ["待办"] }),
    ].join("\n");
    const r = parseFill(text, new Set(["e3", "e4"]), 2);
    expect(r.additions).toEqual([{ item: 2, eventIds: ["e3"] }]);
    expect(r.newItems).toEqual([{ title: "新事项", summary: "小结", eventIds: ["e4"], open: ["待办"] }]);
    expect(r.rejected).toEqual([]);
  });

  test("ids that were not left out, item numbers out of range and malformed lines are rejected", () => {
    const text = [
      JSON.stringify({ item: 1, event_ids: ["e1", "e3"] }),
      JSON.stringify({ item: 3, event_ids: ["e4"] }),
      "{broken",
    ].join("\n");
    const r = parseFill(text, new Set(["e3", "e4"]), 2);
    expect(r.additions).toEqual([{ item: 1, eventIds: ["e3"] }]);
    expect(r.rejected.map((x) => x.reason)).toEqual(["not a left-out event e1", "item number out of range 3", "malformed line"]);
  });
});
