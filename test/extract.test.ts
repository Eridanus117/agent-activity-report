import { expect, test } from "bun:test";
import { buildDigest } from "../src/digest.ts";
import { extractPrompt, extractSession, parseEvents } from "../src/extract.ts";
import type { ModelRunner } from "../src/types.ts";
import { record } from "./helpers.ts";

const at = (m: number) => new Date(2026, 0, 15, 10, m);
const digest = buildDigest([
  record({ kind: "user", text: "修复登录", timestamp: at(0) }), // r1
  record({ kind: "assistant", text: "已修复", timestamp: at(1) }), // r2
  record({ kind: "tool", text: "bash: bun test -> ok", toolOk: true, timestamp: at(2) }), // r3
  record({ kind: "tool", text: "read: a.ts -> NO_RESULT", toolOk: false, timestamp: at(3) }), // r4
  record({ kind: "tool_error", text: "bash: make -> ERROR", timestamp: at(4) }), // r5
]);
const ev = (o: object) => JSON.stringify({ type: "completed", statement: "修好了登录", actor: "agent", evidence: "evidenced", refs: ["r3"], ...o });

test("an event whose references all exist is accepted; one unknown reference rejects it", () => {
  const ok = parseEvents(ev({ refs: ["r2", "r3"] }), digest.refs, "S1");
  expect(ok.events.length).toBe(1);
  expect(ok.rejected).toEqual([]);
  const bad = parseEvents(ev({ refs: ["r3", "r99"] }), digest.refs, "S1");
  expect(bad.events).toEqual([]);
  expect(bad.rejected[0]!.reason).toContain("r99");
});

test("an event without references is rejected", () => {
  expect(parseEvents(ev({ refs: [] }), digest.refs, "S1").rejected.length).toBe(1);
});

test("a malformed line loses only that line", () => {
  const text = [ev({}), '{"type":"decision","statement","broken"}', ev({ statement: "另一件" })].join("\n");
  const r = parseEvents(text, digest.refs, "S1");
  expect(r.events.length).toBe(2);
  expect(r.rejected.length).toBe(1);
  expect(r.rejected[0]!.reason).toBe("malformed line");
});

test("unknown event types and evidence levels are rejected", () => {
  expect(parseEvents(ev({ type: "plan" }), digest.refs, "S1").rejected[0]!.reason).toContain("type");
  expect(parseEvents(ev({ evidence: "sure" }), digest.refs, "S1").rejected[0]!.reason).toContain("evidence");
});

test("evidenced needs a successful tool call or a user record behind it", () => {
  const level = (refs: string[]) => parseEvents(ev({ refs }), digest.refs, "S1").events[0]!.evidence;
  expect(level(["r3"])).toBe("evidenced"); // successful tool call
  expect(level(["r2", "r1"])).toBe("evidenced"); // user record
  expect(level(["r2"])).toBe("self_reported"); // only the agent's own words
  expect(level(["r4"])).toBe("self_reported"); // call without a result
  expect(level(["r5"])).toBe("self_reported"); // failed call
});

test("lower evidence levels are left as the model gave them, and user events are not downgraded", () => {
  expect(parseEvents(ev({ evidence: "attempt", refs: ["r2"] }), digest.refs, "S1").events[0]!.evidence).toBe("attempt");
  const user = parseEvents(ev({ type: "request", actor: "user", refs: ["r1"] }), digest.refs, "S1").events[0]!;
  expect(user.evidence).toBe("evidenced");
});

test("the event time is the earliest referenced record, not what the model says", () => {
  const e = parseEvents(ev({ refs: ["r3", "r2"], time: "23:59" }), digest.refs, "S1").events[0]!;
  expect(e.time).toEqual(at(1));
});

test("the placeholder for 'no events' is neither an event nor a rejection", () => {
  const r = parseEvents('{"none":true}', digest.refs, "S1");
  expect(r.events).toEqual([]);
  expect(r.rejected).toEqual([]);
});

test("from the second chunk on, the prompt lists earlier events of the session as background", () => {
  const first = extractPrompt("2026-01-15", "标题", digest.lines, []);
  const second = extractPrompt("2026-01-15", "标题", digest.lines, ["用户要求修复登录"]);
  expect(first.startsWith("任务：抽取事件")).toBe(true);
  expect(first).not.toContain("此前已抽出的事件");
  expect(second).toContain("此前已抽出的事件");
  expect(second).toContain("用户要求修复登录");
});

test("chunks of a session run in order and each later prompt carries the earlier statements", async () => {
  const prompts: string[] = [];
  const runner: ModelRunner = async (prompt) => {
    prompts.push(prompt);
    const text = prompts.length === 1 ? ev({ statement: "第一块的事件", refs: ["r3"] }) : ev({ statement: "第二块的事件", refs: ["r3"] });
    return { ok: true, text, ms: 1, attempts: 1, cached: false };
  };
  const out = await extractSession({ day: "2026-01-15", label: "S1", title: "标题", chunks: [digest.lines.slice(0, 3), digest.lines.slice(3)], refs: digest.refs, runner });
  expect(out.events.map((e) => e.statement)).toEqual(["第一块的事件", "第二块的事件"]);
  expect(prompts[1]).toContain("第一块的事件");
  expect(out.calls.map((c) => c.status)).toEqual(["ok", "ok"]);
});

test("a failed call is recorded and the remaining chunks still run", async () => {
  let n = 0;
  const runner: ModelRunner = async () => {
    n++;
    return n === 1 ? { ok: false, text: "", ms: 1, attempts: 2, cached: false, error: "exit 1" } : { ok: true, text: ev({}), ms: 1, attempts: 1, cached: false };
  };
  const out = await extractSession({ day: "2026-01-15", label: "S1", title: "t", chunks: [digest.lines.slice(0, 3), digest.lines.slice(3)], refs: digest.refs, runner });
  expect(out.calls.map((c) => c.status)).toEqual(["failed", "ok"]);
  expect(out.events.length).toBe(1);
});
