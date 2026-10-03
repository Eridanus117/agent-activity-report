#!/usr/bin/env bun
// Command-line entry: one report for one local calendar day.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { chunkLines } from "./chunk.ts";
import { fileCoverage, largestItemShare, uncitedUserMessages, worthListing, type FileCoverage } from "./coverage.ts";
import { buildDigest } from "./digest.ts";
import { extractSession, type CallRecord } from "./extract.ts";
import { mergePrompt, overviewPrompt, parseItems, reconcile, usableItems } from "./merge.ts";
import { makeRunner, ompInvoke } from "./model.ts";
import { CHECKED_UNSUPPORTED, detectUnsupported } from "./probe.ts";
import { renderItems, renderOverview } from "./render.ts";
import { selectDay } from "./select.ts";
import * as claudeCode from "./sources/claude-code.ts";
import * as omp from "./sources/omp.ts";
import { itemStatus } from "./status.ts";
import { DEFAULT_LIMITS, type ActivityEvent, type Digest, type Item, type ModelRunner, type ReadResult, type Rejection, type SourceRecord } from "./types.ts";

export const DEFAULT_MODEL = "openai-codex/gpt-6-luna";
export const DEFAULT_CHUNK = 60_000;
export const SOURCES = ["omp", "claude-code"] as const;
export type SourceName = (typeof SOURCES)[number];
const ADAPTERS = { omp, "claude-code": claudeCode } as const;

export interface RunOptions {
  day: string;
  out: string;
  workDir: string;
  model: string;
  chunk: number;
  concurrency: number;
  sources: SourceName[];
  ompRoot: string;
  claudeRoot: string;
  home: string;
  /** This tool's own checkout; reports and work files must stay outside it. */
  repoRoot: string;
}

const REPO_ROOT = resolve(import.meta.dir, "..");

const norm = (p: string) => {
  const abs = resolve(p);
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    // The directory may not exist yet; compare the resolved path.
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
};
const isInside = (child: string, parent: string) => {
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export function defaultWorkDir(home: string): string {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "agent-activity-report");
  if (process.platform === "darwin") return join(home, "Library", "Caches", "agent-activity-report");
  return join(process.env.XDG_CACHE_HOME ?? join(home, ".cache"), "agent-activity-report");
}

export const defaultConfigPath = (home: string) => join(home, ".config", "agent-activity-report", "config.json");

const USAGE = `用法：agent-activity-report --day YYYY-MM-DD [--out 目录] [--source omp,claude-code] [--model 模型] [--chunk 字符数] [--omp-root 目录] [--claude-root 目录] [--work 目录] [--config 文件]
输出目录也可写在配置文件的 "out" 字段（默认配置文件：~/.config/agent-activity-report/config.json）。`;

export function resolveOptions(argv: string[], env: { configPath?: string; home?: string } = {}): RunOptions {
  const home = env.home ?? homedir();
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`无法识别的参数 ${a}\n${USAGE}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`参数 ${a} 缺少取值\n${USAGE}`);
    flags.set(a.slice(2), value);
    i++;
  }
  const configPath = flags.get("config") ?? env.configPath ?? process.env.AGENT_ACTIVITY_REPORT_CONFIG ?? defaultConfigPath(home);
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (e) {
      throw new Error(`配置文件 ${configPath} 无法解析：${String(e)}`);
    }
  }
  const pick = (flag: string, key: string) => flags.get(flag) ?? (typeof config[key] === "string" ? (config[key] as string) : undefined);

  const day = flags.get("day");
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(new Date(`${day}T00:00:00`).getTime())) {
    throw new Error(`--day 必须是 YYYY-MM-DD 形式的日期\n${USAGE}`);
  }
  const out = pick("out", "out");
  if (!out) throw new Error(`没有输出目录：请用 --out 指定，或写在配置文件 ${configPath} 的 "out" 字段\n${USAGE}`);
  const chunkText = flags.get("chunk") ?? (typeof config.chunk === "number" ? String(config.chunk) : undefined);
  const chunk = chunkText === undefined ? DEFAULT_CHUNK : Number(chunkText);
  if (!Number.isInteger(chunk) || chunk < 1000) throw new Error("--chunk 必须是不小于 1000 的整数");
  const sourceText = flags.get("source") ?? (Array.isArray(config.sources) ? config.sources.join(",") : undefined);
  const sources = (sourceText ?? SOURCES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = sources.filter((s) => !(SOURCES as readonly string[]).includes(s));
  if (!sources.length || unknown.length) throw new Error(`--source 只能取 ${SOURCES.join("、")}，收到：${unknown.join("、") || "空"}`);

  return {
    day,
    out: resolve(out),
    workDir: resolve(pick("work", "workDir") ?? defaultWorkDir(home)),
    model: pick("model", "model") ?? DEFAULT_MODEL,
    chunk,
    concurrency: 4,
    sources: [...new Set(sources)] as SourceName[],
    ompRoot: resolve(pick("omp-root", "ompRoot") ?? omp.defaultRoot(home)),
    claudeRoot: resolve(pick("claude-root", "claudeRoot") ?? claudeCode.defaultRoot(home)),
    home,
    repoRoot: REPO_ROOT,
  };
}

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

interface SessionDigest {
  label: string;
  session: string;
  title: string;
  digest: Digest;
}

export async function run(o: RunOptions, runner: ModelRunner) {
  for (const [name, dir] of [["输出目录", o.out], ["工作目录", o.workDir]] as const) {
    if (isInside(dir, o.repoRoot)) throw new Error(`${name} ${dir} 位于本工具的代码仓库内；报告和中间内容含私人会话信息，不能写进代码仓库`);
  }

  // 1. Read every enabled source, then keep the day's records. Files are taken oldest first so
  //    that a record copied into a later session stays with the session it came from.
  const located = o.sources.map((name) => ({ name, result: ADAPTERS[name].locate(name === "omp" ? o.ompRoot : o.claudeRoot) }));
  const reads: { source: SourceName; read: ReadResult; start: number }[] = [];
  for (const { name, result } of located) {
    const root = name === "omp" ? o.ompRoot : o.claudeRoot;
    for (const file of result.files) {
      const read = ADAPTERS[name].read(root, file, DEFAULT_LIMITS);
      const times = read.records.flatMap((r) => (r.timestamp ? [r.timestamp.getTime()] : []));
      reads.push({ source: name, read, start: times.length ? Math.min(...times) : Infinity });
    }
  }
  reads.sort((a, b) => a.start - b.start || (a.read.mtimeMs ?? 0) - (b.read.mtimeMs ?? 0) || a.read.file.localeCompare(b.read.file));

  const files: FileCoverage[] = [];
  const bySession = new Map<string, { title?: string; records: SourceRecord[] }>();
  const seen = new Map<string, string>();
  for (const { source, read } of reads) {
    const selection = selectDay(read.records, o.day, seen);
    files.push(fileCoverage(source, read, selection));
    const key = `${source}:${read.session}`;
    const entry = bySession.get(key) ?? { records: [] };
    if (read.title && !entry.title) entry.title = read.title;
    entry.records.push(...selection.inDay);
    bySession.set(key, entry);
  }
  files.sort((a, b) => a.source.localeCompare(b.source) || a.file.localeCompare(b.file));

  // 2. Digest each session that has something to send.
  const sessions: SessionDigest[] = [];
  for (const key of [...bySession.keys()].sort()) {
    const { title, records } = bySession.get(key)!;
    const digest = buildDigest(records);
    if (digest.lines.length) sessions.push({ label: `S${sessions.length + 1}`, session: key, title: title ?? "", digest });
  }

  // 3. Extract events, sessions in parallel, chunks of one session in order.
  const extracted = await pool(sessions, o.concurrency, (s) =>
    extractSession({ day: o.day, label: s.label, title: s.title, chunks: chunkLines(s.digest.lines, o.chunk), refs: s.digest.refs, runner }),
  );
  const calls: CallRecord[] = extracted.flatMap((x) => x.calls);
  const rejected: Rejection[] = extracted.flatMap((x) => x.rejected);
  const order = new Map(sessions.map((s, i) => [s.label, i]));
  const events: ActivityEvent[] = extracted
    .flatMap((x) => x.events)
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.time.getTime() - b.e.time.getTime() || order.get(a.e.session)! - order.get(b.e.session)! || a.i - b.i)
    .map(({ e }, i) => ({ ...e, id: `e${i + 1}` }));
  const byId = new Map(events.map((e) => [e.id, e]));

  // 4. Group into items, decide statuses by rule, then write the overview from the items.
  let items: Item[] = [];
  let orphans = events;
  let duplicates = 0;
  let mergeFailed = false;
  let overview = "";
  if (events.length) {
    const titles = new Map(sessions.map((s) => [s.label, s.title]));
    const merged = await runner(mergePrompt(o.day, events, titles), usableItems);
    calls.push({ name: "merge", session: "", chars: events.length, ms: merged.ms, status: merged.ok ? "ok" : "failed", attempts: merged.attempts, cached: merged.cached, ...(merged.error ? { error: merged.error } : {}) });
    if (merged.ok) {
      const parsed = parseItems(merged.text, new Set(byId.keys()));
      rejected.push(...parsed.rejected);
      const r = reconcile(parsed.items, events);
      orphans = r.orphans;
      duplicates = r.duplicates;
      const position = (id: string) => Number(id.slice(1));
      items = r.items
        .map((it) => {
          const ids = [...it.eventIds].sort((a, b) => position(a) - position(b));
          return { ...it, eventIds: ids, status: itemStatus(ids.map((id) => byId.get(id)!)) };
        })
        .sort((a, b) => position(a.eventIds[0]!) - position(b.eventIds[0]!));
    } else mergeFailed = true;
    if (items.length) {
      const ov = await runner(overviewPrompt(o.day, items), (t) => t.trim().length > 0);
      calls.push({ name: "overview", session: "", chars: items.length, ms: ov.ms, status: ov.ok ? "ok" : "failed", attempts: ov.attempts, cached: ov.cached, ...(ov.error ? { error: ov.error } : {}) });
      if (ov.ok) overview = ov.text;
    }
  }

  // 5. Coverage and outputs.
  const uncited = uncitedUserMessages(sessions, events);
  const failedLabels = new Set(calls.filter((c) => c.status === "failed" && c.session).map((c) => c.session));
  const unsupportedFound = detectUnsupported(o.home);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const userMessages = sessions.reduce((n, s) => n + [...s.digest.refs.values()].filter((r) => r.kind === "user" && !r.subagent).length, 0);
  const notRead = SOURCES.filter((s) => !o.sources.includes(s));
  const coverage = {
    day: o.day,
    timezone,
    model: o.model,
    generatedAt: new Date().toISOString(),
    sources: {
      supported: located.map(({ name, result }) => ({ source: name, present: result.exists, filesScanned: result.files.length, listErrors: result.errors })),
      notSelected: notRead,
      detectedUnsupported: unsupportedFound,
      checkedUnsupported: CHECKED_UNSUPPORTED,
      note: `读取：${o.sources.join("、")}${notRead.length ? `；本次未选：${notRead.join("、")}` : ""}；其余客户端既不读取，除 ${CHECKED_UNSUPPORTED.join("、")} 外也不在检测范围内。`,
    },
    files: files.filter(worthListing),
    sessions: sessions.map((s) => ({ label: s.label, session: s.session, title: s.title, lines: s.digest.lines.length, chars: s.digest.lines.reduce((n, l) => n + l.text.length + 1, 0) })),
    calls,
    rejected,
    events: events.length,
    items: items.length,
    unmergedEvents: orphans.length,
    eventsInMultipleItems: duplicates,
    largestItemShare: largestItemShare(items.map((i) => i.eventIds.length), events.length),
    userMessages,
    uncitedUserMessages: uncited,
  };

  const dayDir = join(o.out, o.day);
  mkdirSync(dayDir, { recursive: true });
  const unsupportedText = [
    notRead.length ? `本次未选：${notRead.join("、")}` : "",
    unsupportedFound.length ? `本机检测到但不支持：${unsupportedFound.join("、")}` : "",
    "其余客户端不在检测范围",
  ].filter(Boolean).join("；");
  writeFileSync(
    join(dayDir, "overview.md"),
    renderOverview({
      day: o.day, timezone, model: o.model, unsupported: unsupportedText,
      supported: located.map(({ name, result }) => (result.exists ? name : `${name}（本机未找到记录目录）`)),
      filesScanned: located.reduce((n, l) => n + l.result.files.length, 0), sessions: sessions.length,
      readFailures: files.filter((f) => f.status !== "ok").length + located.reduce((n, l) => n + l.result.errors.length, 0),
      badLines: files.reduce((n, f) => n + f.badLines, 0), calls: calls.length,
      failedSessions: sessions.filter((s) => failedLabels.has(s.label)).map((s) => ({ label: s.label, title: s.title })),
      mergeFailed, events: events.length, rejected: rejected.length, unmerged: orphans.length,
      userMessages, uncited: uncited.length, overview, items,
    }),
  );
  writeFileSync(join(dayDir, "items.md"), renderItems({ day: o.day, items, orphans, events: byId, refs: new Map(sessions.map((s) => [s.label, s.digest.refs])) }));
  writeFileSync(join(dayDir, "coverage.json"), `${JSON.stringify(coverage, null, 2)}\n`);
  return coverage;
}

async function main() {
  let options: RunOptions;
  try {
    options = resolveOptions(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const runner = makeRunner(ompInvoke({ model: options.model, workDir: join(options.workDir, "work") }), {
    model: options.model,
    cacheDir: join(options.workDir, "cache"),
  });
  try {
    const c = await run(options, runner);
    const failed = c.calls.filter((x) => x.status === "failed").length;
    console.log(`${options.day}: 会话 ${c.sessions.length}，事件 ${c.events}，事项 ${c.items}，模型调用 ${c.calls.length}（失败 ${failed}）`);
    console.log(`输出：${join(options.out, options.day)}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

if (import.meta.main) await main();
