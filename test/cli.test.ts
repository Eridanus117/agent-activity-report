import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveOptions, run, type RunOptions } from "../src/cli.ts";
import type { ModelRunner } from "../src/types.ts";
import { cc, fakeRunner, localIso, omp, tmpDir, writeJsonl } from "./helpers.ts";

const DAY = "2026-01-15";
const REPO = resolve(import.meta.dir, "..");
const at = (h: number, m: number) => localIso(2026, 1, 15, h, m);

/** Two sessions on the day, one record the day before, and a subagent file. */
function fixture() {
  const home = tmpDir();
  const root = join(home, ".omp", "agent", "sessions");
  writeJsonl(join(root, "proj", "s1.jsonl"), [
    omp.title("登录修复"),
    omp.session(localIso(2026, 1, 14, 22, 0), "登录修复"),
    omp.user(localIso(2026, 1, 14, 22, 1), "昨天的请求"),
    omp.user(at(9, 0), "修复登录跳转"),
    omp.assistant(at(9, 1), [omp.thinking("…"), omp.call("c1", "bash", { command: "bun test" }, "run tests")]),
    omp.result(at(9, 2), "c1", "3 pass"),
    omp.assistant(at(9, 3), [omp.text("已修复")]),
    omp.user(at(9, 10), "再补一个测试"),
  ]);
  writeJsonl(join(root, "proj", "s1", "sub1.jsonl"), [omp.sessionInit(at(9, 4), "scout", "查找入口"), omp.assistant(at(9, 5), [omp.text("入口在 a.ts")])]);
  writeJsonl(join(root, "proj", "s2.jsonl"), [omp.session(at(14, 0), "文档"), omp.user(at(14, 0), "更新 README")]);
  return { home, root };
}

function options(home: string, root: string, extra: Partial<RunOptions> = {}): RunOptions {
  return {
    day: DAY, out: tmpDir(), workDir: tmpDir(), model: "fake", chunk: 60_000, concurrency: 2,
    sources: ["omp", "claude-code"], ompRoot: root, claudeRoot: join(home, ".claude", "projects"), home, repoRoot: REPO, ...extra,
  };
}

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name]));

describe("run", () => {
  test("writes exactly the three outputs for the day, traceable to files and lines", async () => {
    const { home, root } = fixture();
    const opts = options(home, root);
    await run(opts, fakeRunner());
    expect(filesUnder(opts.out).sort()).toEqual([`${DAY}/coverage.json`, `${DAY}/items.md`, `${DAY}/overview.md`]);
    const overview = readFileSync(join(opts.out, DAY, "overview.md"), "utf8");
    const items = readFileSync(join(opts.out, DAY, "items.md"), "utf8");
    expect(overview).toContain("合成概览");
    expect(overview).toContain("合成事项");
    expect(items).toContain("用户要求：修复登录跳转");
    expect(items).toContain("proj/s1.jsonl 行 4");
    expect(items).not.toContain("昨天的请求");
  });

  test("the coverage list reports sources, files, calls and uncited user messages", async () => {
    const { home, root } = fixture();
    mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
    // Cites only the first user message of each session.
    const runner: ModelRunner = async (prompt, accept) => {
      if (!prompt.startsWith("任务：抽取事件")) return fakeRunner()(prompt, accept);
      const ref = /^\[(r\d+)\] \d\d:\d\d USER: /m.exec(prompt)![1];
      return { ok: true, text: JSON.stringify({ type: "request", statement: "请求", actor: "user", evidence: "evidenced", refs: [ref] }), ms: 1, attempts: 1, cached: false };
    };
    const opts = options(home, root);
    await run(opts, runner);
    const cov = JSON.parse(readFileSync(join(opts.out, DAY, "coverage.json"), "utf8"));
    expect(cov.day).toBe(DAY);
    expect(cov.model).toBe("fake");
    expect(cov.sources.supported).toEqual([
      { source: "omp", present: true, filesScanned: 3, listErrors: [] },
      { source: "claude-code", present: false, filesScanned: 0, listErrors: [] },
    ]);
    expect(cov.sources.detectedUnsupported).toEqual(["codex"]);
    expect(cov.files.map((f: any) => f.file).sort()).toEqual(["proj/s1.jsonl", "proj/s1/sub1.jsonl", "proj/s2.jsonl"]);
    const s1 = cov.files.find((f: any) => f.file === "proj/s1.jsonl");
    expect(s1).toMatchObject({ status: "ok", records: 8, inDay: 5, noTimestamp: 1, badLines: 0 });
    expect(cov.calls.length).toBeGreaterThanOrEqual(3);
    expect(cov.uncitedUserMessages).toEqual([{ session: "S1", file: "proj/s1.jsonl", line: 8 }]);
    expect(cov.events).toBeGreaterThan(0);
    expect(cov.largestItemShare).toBe(1);
  });

  test("a session whose model call fails is named in the overview and its content is absent", async () => {
    const { home, root } = fixture();
    const base = fakeRunner();
    const runner: ModelRunner = async (prompt, accept) =>
      prompt.includes("会话标题：文档") ? { ok: false, text: "", ms: 1, attempts: 2, cached: false, error: "exit 1" } : base(prompt, accept);
    const opts = options(home, root);
    await run(opts, runner);
    const overview = readFileSync(join(opts.out, DAY, "overview.md"), "utf8");
    expect(overview).toMatch(/S2.*未进入报告/);
    expect(readFileSync(join(opts.out, DAY, "items.md"), "utf8")).not.toContain("更新 README");
  });

  test("an output directory inside this repository is refused and nothing is written", async () => {
    const { home, root } = fixture();
    const out = join(REPO, "reports-should-not-exist");
    await expect(run(options(home, root, { out }), fakeRunner())).rejects.toThrow("代码仓库");
    expect(existsSync(out)).toBe(false);
  });

  test("a work directory inside this repository is refused too", async () => {
    const { home, root } = fixture();
    await expect(run(options(home, root, { workDir: join(REPO, "work-should-not-exist") }), fakeRunner())).rejects.toThrow("代码仓库");
  });

  test("the run does not add or change session files", async () => {
    const { home, root } = fixture();
    const before = filesUnder(root).map((f) => [f, readFileSync(join(root, f), "utf8")]);
    await run(options(home, root), fakeRunner());
    expect(filesUnder(root).map((f) => [f, readFileSync(join(root, f), "utf8")])).toEqual(before);
  });

  test("a missing omp root is reported as absent and still produces the outputs", async () => {
    const home = tmpDir();
    const opts = options(home, join(home, "none"));
    await run(opts, fakeRunner());
    const cov = JSON.parse(readFileSync(join(opts.out, DAY, "coverage.json"), "utf8"));
    expect(cov.sources.supported[0].present).toBe(false);
    expect(existsSync(join(opts.out, DAY, "overview.md"))).toBe(true);
  });
});

describe("two sources", () => {
  /** omp fixture plus a Claude Code session on the same day. */
  function both() {
    const { home, root } = fixture();
    const claudeRoot = join(home, ".claude", "projects");
    writeJsonl(join(claudeRoot, "proj", "c1.jsonl"), [cc.aiTitle("Claude 会话"), cc.user(at(11, 0), "整理测试"), cc.assistant(at(11, 1), [cc.text("好")])]);
    return { home, root, claudeRoot };
  }

  test("both sources end up in the outputs and are listed separately in the coverage list", async () => {
    const { home, root } = both();
    const opts = options(home, root);
    await run(opts, fakeRunner());
    const cov = JSON.parse(readFileSync(join(opts.out, DAY, "coverage.json"), "utf8"));
    expect(cov.sources.supported.map((s: any) => [s.source, s.present, s.filesScanned])).toEqual([["omp", true, 3], ["claude-code", true, 1]]);
    expect(cov.files.map((f: any) => `${f.source}:${f.file}`)).toContain("claude-code:proj/c1.jsonl");
    const items = readFileSync(join(opts.out, DAY, "items.md"), "utf8");
    expect(items).toContain("用户要求：整理测试");
    expect(items).toContain("claude-code proj/c1.jsonl 行 2");
    expect(items).toContain("omp proj/s1.jsonl 行 4");
  });

  test("a record copied into a later session file is kept once, in the session that started first", async () => {
    const { home, root, claudeRoot } = both();
    // "z0" is the original; "c2" is a later session that copied z0's record, timestamp included,
    // before adding its own. Both start at the same time, so the older file wins. The names are
    // chosen so that path order alone would pick the copy.
    const original = join(claudeRoot, "proj", "z0.jsonl");
    const copy = join(claudeRoot, "proj", "c2.jsonl");
    writeJsonl(copy, [cc.user(at(9, 30), "原始请求", undefined, "shared"), cc.user(at(13, 0), "继续")]);
    writeJsonl(original, [cc.user(at(9, 30), "原始请求", undefined, "shared")]);
    utimesSync(original, new Date(2026, 0, 15, 12), new Date(2026, 0, 15, 12));
    utimesSync(copy, new Date(2026, 0, 15, 18), new Date(2026, 0, 15, 18));
    const opts = options(home, root);
    const cov = await run(opts, fakeRunner());
    const z0 = cov.sessions.find((s) => s.session === "claude-code:proj/z0")!;
    const c2 = cov.sessions.find((s) => s.session === "claude-code:proj/c2")!;
    const items = readFileSync(join(opts.out, DAY, "items.md"), "utf8");
    expect(items.match(/用户要求：原始请求/g)!.length).toBe(1);
    expect(items).toContain(`来源 ${z0.label}：claude-code proj/z0.jsonl 行 1`);
    expect(c2.lines).toBe(1);
    expect(cov.files.find((f) => f.file === "proj/c2.jsonl")!.duplicates).toBe(1);
  });

  test("--source limits which sources are read", async () => {
    const { home, root } = both();
    const opts = options(home, root, { sources: ["omp"] });
    const cov = await run(opts, fakeRunner());
    expect(cov.sources.supported.map((s: any) => s.source)).toEqual(["omp"]);
    expect(readFileSync(join(opts.out, DAY, "items.md"), "utf8")).not.toContain("整理测试");
  });

  test("an unknown source name is an error", () => {
    expect(() => resolveOptions(["--day", DAY, "--out", tmpDir(), "--source", "codex"], { configPath: join(tmpDir(), "none.json"), home: tmpDir() })).toThrow("--source");
  });
});

describe("resolveOptions", () => {
  test("no output directory is an error", () => {
    expect(() => resolveOptions(["--day", DAY], { configPath: join(tmpDir(), "none.json"), home: tmpDir() })).toThrow("输出目录");
  });

  test("a malformed day is an error", () => {
    expect(() => resolveOptions(["--day", "2026-1-5", "--out", tmpDir()], { configPath: join(tmpDir(), "none.json"), home: tmpDir() })).toThrow("--day");
  });

  test("the output directory can come from the config file", () => {
    const dir = tmpDir();
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ out: "D:/reports", model: "m2" }));
    const o = resolveOptions(["--day", DAY], { configPath, home: dir });
    expect(o.out).toBe(resolve("D:/reports"));
    expect(o.model).toBe("m2");
  });
});
