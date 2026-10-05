import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { computeRecap, renderRecap, resolveRecapOptions, runRecap, type RecapOptions } from "../src/recap.ts";
import * as claudeCode from "../src/sources/claude-code.ts";
import * as omp from "../src/sources/omp.ts";
import { DEFAULT_LIMITS } from "../src/types.ts";
import { cc, localIso, omp as o, tmpDir, writeJsonl } from "./helpers.ts";

const REPO = resolve(import.meta.dir, "..");
const t = (day: number, h: number, m = 0) => localIso(2026, 1, day, h, m);

/** Synthetic home with two omp sessions and one Claude Code session. */
function fixture() {
  const home = tmpDir();
  const ompRoot = join(home, ".omp", "agent", "sessions");
  const ccRoot = join(home, ".claude", "projects");
  writeJsonl(join(ompRoot, "proj", "a.jsonl"), [
    o.title("会话甲"),
    o.session(t(10, 9), "会话甲"),
    o.user(t(10, 9, 0), "开始"),
    o.assistant(t(10, 9, 1), [o.call("c1", "bash", { command: "ls" })]),
    o.result(t(10, 9, 2), "c1", "ok"),
    o.assistant(t(10, 9, 3), [o.call("c2", "bash", { command: "bad" })]),
    o.result(t(10, 9, 4), "c2", "boom", true),
    // 50 minutes of silence, then three more minutes of work.
    o.user(t(10, 10, 0), "继续"),
    o.assistant(t(10, 10, 3), [o.text("好")]),
  ]);
  writeJsonl(join(ompRoot, "proj", "b.jsonl"), [
    o.title("会话乙"),
    o.session(t(11, 1), "会话乙"),
    o.user(t(11, 1, 30), "深夜的消息"),
    o.user(t(11, 3, 15), "更晚的消息"),
  ]);
  writeJsonl(join(ccRoot, "proj", "s1.jsonl"), [
    cc.aiTitle("会话丙"),
    cc.user(t(10, 14, 0), "你好"),
    cc.assistant(t(10, 14, 1), [cc.toolUse("t1", "Bash", { command: "ls" })]),
    cc.toolResult(t(10, 14, 2), "t1", "x"),
    cc.prLink(t(10, 14, 3), "demo/repo", 7),
    cc.user(t(10, 14, 4), "[Request interrupted by user]", { origin: { kind: "human" } }),
  ]);
  return { home, ompRoot, ccRoot };
}

function inputs(f: ReturnType<typeof fixture>) {
  const all = [];
  for (const [source, adapter, root] of [["omp", omp, f.ompRoot], ["claude-code", claudeCode, f.ccRoot]] as const) {
    for (const file of adapter.locate(root).files) all.push({ source, read: adapter.read(root, file, DEFAULT_LIMITS) });
  }
  return all;
}

describe("computeRecap", () => {
  test("counts sessions per local day across sources", () => {
    const r = computeRecap(inputs(fixture()));
    expect(r.days).toEqual([{ day: "2026-01-10", sessions: 2 }, { day: "2026-01-11", sessions: 1 }]);
    expect(r.sessions).toBe(3);
  });

  test("active time skips long gaps while span includes them", () => {
    const r = computeRecap(inputs(fixture()));
    const a = r.longest.find((s) => s.title === "会话甲")!;
    expect(a.spanMs).toBe(63 * 60_000);
    expect(a.activeMs).toBe((4 + 3) * 60_000);
    expect(a.userMessages).toBe(2);
    expect(r.longest[0]!.title).toBe("会话甲");
  });

  test("tool calls are counted by name with errors, and pr-link is not a tool call", () => {
    const r = computeRecap(inputs(fixture()));
    expect(r.tools.find((x) => x.source === "omp")!.tools).toEqual([{ name: "bash", calls: 2, errors: 1 }]);
    expect(r.tools.find((x) => x.source === "claude-code")!.tools).toEqual([{ name: "Bash", calls: 1, errors: 0 }]);
  });

  test("user messages are binned by local hour and the latest night message is reported", () => {
    const r = computeRecap(inputs(fixture()));
    expect(r.hours[1]).toBe(1);
    expect(r.hours[3]).toBe(1);
    expect(r.hours[9]).toBe(1);
    expect(r.latestNight).toEqual({ day: "2026-01-11", time: "03:15" });
    expect(r.userMessages).toBe(5);
  });

  test("interruptions are counted", () => {
    expect(computeRecap(inputs(fixture())).interrupts).toBe(1);
  });

  test("the date range limits the counts but coverage still shows the full span", () => {
    const r = computeRecap(inputs(fixture()), { from: "2026-01-11", to: "2026-01-11" });
    expect(r.days).toEqual([{ day: "2026-01-11", sessions: 1 }]);
    expect(r.sessions).toBe(1);
    const c = r.coverage.find((x) => x.source === "omp")!;
    expect([c.firstDay, c.lastDay]).toEqual(["2026-01-10", "2026-01-11"]);
    expect(c.sessions).toBe(2);
  });

  test("a record copied into a second file is counted once", () => {
    const home = tmpDir();
    const root = join(home, "sessions");
    const shared = o.user(t(10, 9), "同一条", "dup1");
    writeJsonl(join(root, "p", "a.jsonl"), [o.session(t(10, 9), "甲"), shared]);
    writeJsonl(join(root, "p", "b.jsonl"), [o.session(t(10, 9, 5), "乙"), shared]);
    const reads = omp.locate(root).files.map((f) => ({ source: "omp", read: omp.read(root, f, DEFAULT_LIMITS) }));
    expect(computeRecap(reads).userMessages).toBe(1);
  });

  test("an empty input yields an empty recap", () => {
    const r = computeRecap([]);
    expect(r.sessions).toBe(0);
    expect(r.days).toEqual([]);
    expect(r.latestNight).toBeUndefined();
    expect(renderRecap(r)).toContain("个人使用回顾");
  });
});

describe("renderRecap", () => {
  test("escapes titles and states the coverage dates", () => {
    const home = tmpDir();
    const root = join(home, "sessions");
    writeJsonl(join(root, "p", "a.jsonl"), [o.session(t(10, 9), "<script>x</script>"), o.user(t(10, 9), "hi")]);
    const reads = omp.locate(root).files.map((f) => ({ source: "omp", read: omp.read(root, f, DEFAULT_LIMITS) }));
    const html = renderRecap(computeRecap(reads));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("2026-01-10 至 2026-01-10");
  });
});

describe("runRecap and options", () => {
  const options = (f: ReturnType<typeof fixture>, extra: Partial<RecapOptions> = {}): RecapOptions => ({
    out: tmpDir(), sources: ["omp", "claude-code"], ompRoot: f.ompRoot, claudeRoot: f.ccRoot, repoRoot: REPO, ...extra,
  });

  test("writes one HTML file to the output directory", () => {
    const f = fixture();
    const opts = options(f);
    const { file } = runRecap(opts);
    expect(file).toBe(join(opts.out, "recap.html"));
    expect(readFileSync(file, "utf8")).toContain("会话甲");
  });

  test("refuses an output directory inside the repository", () => {
    const f = fixture();
    expect(() => runRecap(options(f, { out: join(REPO, "recap-out") }))).toThrow("代码仓库内");
  });

  test("a source can be left out", () => {
    const f = fixture();
    const { recap } = runRecap(options(f, { sources: ["claude-code"] }));
    expect(recap.coverage.map((c) => c.source)).toEqual(["claude-code"]);
  });

  test("option parsing validates dates and sources and needs an output directory", () => {
    const env = { home: tmpDir() };
    expect(() => resolveRecapOptions([], env)).toThrow("没有输出目录");
    expect(() => resolveRecapOptions(["--out", "x", "--from", "2026-13-40"], env)).toThrow("YYYY-MM-DD");
    expect(() => resolveRecapOptions(["--out", "x", "--from", "2026-02-01", "--to", "2026-01-01"], env)).toThrow("不能晚于");
    expect(() => resolveRecapOptions(["--out", "x", "--source", "codex"], env)).toThrow("--source");
    const ok = resolveRecapOptions(["--out", "x", "--from", "2026-01-01"], env);
    expect(ok.from).toBe("2026-01-01");
    expect(ok.sources).toEqual(["omp", "claude-code"]);
  });
});
