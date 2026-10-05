#!/usr/bin/env bun
// Personal recap: counts taken from the raw session records, written as one local HTML page.
// No model calls. See issue #12.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ADAPTERS, defaultConfigPath, isInside, SOURCES, type SourceName } from "./cli.ts";
import { localDay } from "./select.ts";
import * as claudeCode from "./sources/claude-code.ts";
import * as omp from "./sources/omp.ts";
import { DEFAULT_LIMITS, type ReadResult } from "./types.ts";

/** Consecutive records closer than this count as continuous work; longer gaps are idle time. */
export const ACTIVE_GAP_MS = 5 * 60_000;
/** User messages sent before this local hour are listed as late-night work. */
const NIGHT_UNTIL_HOUR = 6;
const TOP_SESSIONS = 5;
const TOP_TOOLS = 10;

export interface RecapInput {
  source: string;
  read: ReadResult;
}

export interface SourceCoverage {
  source: string;
  files: number;
  sessions: number;
  /** Earliest and latest local day with any record, before the requested range is applied. */
  firstDay?: string;
  lastDay?: string;
  readFailures: number;
  badLines: number;
}

export interface SessionStat {
  source: string;
  title: string;
  /** Local day of the session's first counted record. */
  day: string;
  spanMs: number;
  activeMs: number;
  userMessages: number;
}

export interface ToolStat {
  name: string;
  calls: number;
  errors: number;
}

export interface Recap {
  range: { from?: string; to?: string };
  timezone: string;
  coverage: SourceCoverage[];
  sessions: number;
  userMessages: number;
  /** Interrupted or aborted turns. */
  interrupts: number;
  days: { day: string; sessions: number }[];
  longest: SessionStat[];
  /** User messages per local hour, index 0–23. */
  hours: number[];
  latestNight?: { day: string; time: string };
  tools: { source: string; tools: ToolStat[] }[];
}

const pad = (n: number) => String(n).padStart(2, "0");
const toolName = (text: string) => text.split(/[\s:(]/, 1)[0] ?? "";

export function computeRecap(inputs: RecapInput[], range: { from?: string; to?: string } = {}): Recap {
  // Oldest file first, so a record copied into a later session stays with the session it came from.
  const start = (i: RecapInput) => Math.min(...i.read.records.flatMap((r) => (r.timestamp ? [r.timestamp.getTime()] : [])), Infinity);
  const ordered = [...inputs].sort((a, b) => start(a) - start(b) || (a.read.mtimeMs ?? 0) - (b.read.mtimeMs ?? 0) || a.read.file.localeCompare(b.read.file));

  const coverage = new Map<string, SourceCoverage & { keys: Set<string> }>();
  const seen = new Map<string, string>();
  const sessions = new Map<string, { source: string; title: string; times: number[]; users: number; real: boolean }>();
  const dayKeys = new Map<string, Set<string>>();
  const toolsBySource = new Map<string, Map<string, ToolStat>>();
  const hours = new Array<number>(24).fill(0);
  let latestNight: { day: string; time: string; minutes: number } | undefined;
  let userMessages = 0;
  let interrupts = 0;

  for (const { source, read } of ordered) {
    const cov = coverage.get(source) ?? { source, files: 0, sessions: 0, readFailures: 0, badLines: 0, keys: new Set<string>() };
    coverage.set(source, cov);
    cov.files++;
    cov.badLines += read.badLines;
    if (read.error) {
      cov.readFailures++;
      continue;
    }
    const key = `${source}:${read.session}`;
    cov.keys.add(key);

    for (const r of read.records) {
      if (!r.timestamp) continue;
      const day = localDay(r.timestamp);
      if (!cov.firstDay || day < cov.firstDay) cov.firstDay = day;
      if (!cov.lastDay || day > cov.lastDay) cov.lastDay = day;
      if ((range.from && day < range.from) || (range.to && day > range.to)) continue;
      if (r.id !== undefined) {
        const idKey = `${source}:${r.id}`;
        const where = `${r.file}:${r.line}`;
        const first = seen.get(idKey);
        if (first === undefined) seen.set(idKey, where);
        else if (first !== where) continue;
      }
      // Skipped records (tool results and the like) still show the session was running, so they
      // count towards active time, but they do not make a session or a day active on their own.
      const s = sessions.get(key) ?? { source, title: "", times: [], users: 0, real: false };
      sessions.set(key, s);
      if (read.title && !s.title) s.title = read.title;
      s.times.push(r.timestamp.getTime());
      if (r.kind === "skipped") continue;
      s.real = true;
      (dayKeys.get(day) ?? dayKeys.set(day, new Set()).get(day)!).add(key);

      if (r.kind === "user" && !r.subagent) {
        s.users++;
        userMessages++;
        const h = r.timestamp.getHours();
        hours[h]!++;
        const minutes = h * 60 + r.timestamp.getMinutes();
        if (h < NIGHT_UNTIL_HOUR && (!latestNight || minutes > latestNight.minutes)) latestNight = { day, time: `${pad(h)}:${pad(r.timestamp.getMinutes())}`, minutes };
      } else if (r.kind === "tool" || r.kind === "tool_error" || r.kind === "ask") {
        // Client-generated pr-link records are not tool calls.
        if (r.rawType === "pr-link") continue;
        const name = toolName(r.text);
        const table = toolsBySource.get(source) ?? toolsBySource.set(source, new Map()).get(source)!;
        const t = table.get(name) ?? { name, calls: 0, errors: 0 };
        table.set(name, t);
        t.calls++;
        if (r.kind === "tool_error") t.errors++;
      } else if (r.kind === "stop" && /interrupted|aborted/.test(r.text)) interrupts++;
    }
  }

  const counted = [...sessions.values()].filter((s) => s.real);
  const stats: SessionStat[] = counted.map((s) => {
    const times = s.times.sort((a, b) => a - b);
    let activeMs = 0;
    for (let i = 1; i < times.length; i++) if (times[i]! - times[i - 1]! <= ACTIVE_GAP_MS) activeMs += times[i]! - times[i - 1]!;
    return { source: s.source, title: s.title, day: localDay(new Date(times[0]!)), spanMs: times.at(-1)! - times[0]!, activeMs, userMessages: s.users };
  });

  return {
    range,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    coverage: [...coverage.values()].map(({ keys, ...c }) => ({ ...c, sessions: keys.size })),
    sessions: counted.length,
    userMessages,
    interrupts,
    days: [...dayKeys].map(([day, set]) => ({ day, sessions: set.size })).sort((a, b) => a.day.localeCompare(b.day)),
    longest: stats.sort((a, b) => b.activeMs - a.activeMs).slice(0, TOP_SESSIONS),
    hours,
    ...(latestNight ? { latestNight: { day: latestNight.day, time: latestNight.time } } : {}),
    tools: [...toolsBySource].map(([source, table]) => ({ source, tools: [...table.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)).slice(0, TOP_TOOLS) })),
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hm = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`;
};

function bars(rows: { label: string; value: number; note?: string }[]): string {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<table class="bars">${rows
    .map((r) => `<tr><td>${esc(r.label)}</td><td><div style="width:${((r.value / max) * 100).toFixed(1)}%"></div></td><td>${r.value}${r.note ? ` <small>${esc(r.note)}</small>` : ""}</td></tr>`)
    .join("")}</table>`;
}

export function renderRecap(r: Recap): string {
  const range = r.range.from || r.range.to ? `${r.range.from ?? "最早"} 至 ${r.range.to ?? "最新"}` : "全部可用记录";
  const covRows = r.coverage
    .map((c) => `<tr><td>${esc(c.source)}</td><td>${c.firstDay ?? "—"} 至 ${c.lastDay ?? "—"}</td><td>${c.files}</td><td>${c.sessions}</td><td>${c.readFailures}</td><td>${c.badLines}</td></tr>`)
    .join("");
  const longest = r.longest
    .map((s) => `<tr><td>${esc(s.title || "（无标题）")}</td><td>${esc(s.source)}</td><td>${s.day}</td><td>${hm(s.activeMs)}</td><td>${hm(s.spanMs)}</td><td>${s.userMessages}</td></tr>`)
    .join("");
  const tools = r.tools
    .map((t) => `<h3>${esc(t.source)}</h3>${bars(t.tools.map((x) => ({ label: x.name, value: x.calls, note: x.errors ? `出错 ${x.errors}（${((x.errors / x.calls) * 100).toFixed(0)}%）` : "" })))}`)
    .join("");
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>个人使用回顾</title>
<style>
body{font:15px/1.6 system-ui,sans-serif;max-width:860px;margin:2em auto;padding:0 1em;color:#222}
table{border-collapse:collapse;width:100%}td,th{padding:.2em .6em;text-align:left;border-bottom:1px solid #ddd}
.bars td:nth-child(1){width:7em;white-space:nowrap}.bars td:nth-child(2){width:55%}.bars div{background:#4a7bd0;height:.9em}
small{color:#666}
</style></head><body>
<h1>个人使用回顾</h1>
<p>统计范围：${esc(range)}（本地时区 ${esc(r.timezone)}）。只数记录，不调用模型。会话 ${r.sessions} 个，用户消息 ${r.userMessages} 条，被打断或中止 ${r.interrupts} 次。</p>
<h2>覆盖范围</h2>
<p>本机原始记录会被客户端清理，早于下列日期的活动统计不到。</p>
<table><tr><th>来源</th><th>记录所跨日期</th><th>文件</th><th>会话</th><th>读取失败</th><th>坏行</th></tr>${covRows}</table>
<h2>每天的会话数</h2>${bars(r.days.map((d) => ({ label: d.day, value: d.sessions })))}
<h2>最长的会话</h2>
<p>活跃时长只累计相邻记录间隔不超过 ${ACTIVE_GAP_MS / 60_000} 分钟的部分；跨度是首尾之差，包含挂机。</p>
<table><tr><th>标题</th><th>来源</th><th>开始日</th><th>活跃时长</th><th>跨度</th><th>用户消息</th></tr>${longest}</table>
<h2>几点在工作</h2>
<p>各小时发出的用户消息数。${r.latestNight ? `凌晨（0–${NIGHT_UNTIL_HOUR - 1} 点）最晚的一条：${r.latestNight.day} ${r.latestNight.time}。` : `凌晨（0–${NIGHT_UNTIL_HOUR - 1} 点）没有用户消息。`}</p>
${bars(r.hours.map((v, h) => ({ label: `${pad(h)} 时`, value: v })))}
<h2>最常用的工具</h2>${tools}
</body></html>
`;
}

const USAGE = `用法：recap [--out 目录] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--source omp,claude-code] [--omp-root 目录] [--claude-root 目录] [--config 文件]
输出目录也可写在配置文件的 "out" 字段（默认：~/.config/agent-activity-report/config.json）。页面写到 <out>/recap.html，必须在本仓库之外。`;

export interface RecapOptions {
  out: string;
  from?: string;
  to?: string;
  sources: SourceName[];
  ompRoot: string;
  claudeRoot: string;
  repoRoot: string;
}

const validDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(new Date(`${d}T00:00:00`).getTime());

export function resolveRecapOptions(argv: string[], env: { home?: string; configPath?: string } = {}): RecapOptions {
  const home = env.home ?? homedir();
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const a = argv[i]!;
    const value = argv[i + 1];
    if (!a.startsWith("--")) throw new Error(`无法识别的参数 ${a}\n${USAGE}`);
    if (value === undefined || value.startsWith("--")) throw new Error(`参数 ${a} 缺少取值\n${USAGE}`);
    flags.set(a.slice(2), value);
  }
  const configPath = flags.get("config") ?? env.configPath ?? defaultConfigPath(home);
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (e) {
      throw new Error(`配置文件 ${configPath} 无法解析：${String(e)}`);
    }
  }
  const pick = (flag: string, key: string) => flags.get(flag) ?? (typeof config[key] === "string" ? (config[key] as string) : undefined);

  const out = pick("out", "out");
  if (!out) throw new Error(`没有输出目录：请用 --out 指定，或写在配置文件 ${configPath} 的 "out" 字段\n${USAGE}`);
  const from = flags.get("from");
  const to = flags.get("to");
  for (const [name, d] of [["--from", from], ["--to", to]] as const) if (d !== undefined && !validDay(d)) throw new Error(`${name} 必须是 YYYY-MM-DD 形式的日期\n${USAGE}`);
  if (from && to && from > to) throw new Error("--from 不能晚于 --to");
  const sourceText = flags.get("source") ?? (Array.isArray(config.sources) ? config.sources.join(",") : undefined);
  const sources = (sourceText ?? SOURCES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = sources.filter((s) => !(SOURCES as readonly string[]).includes(s));
  if (!sources.length || unknown.length) throw new Error(`--source 只能取 ${SOURCES.join("、")}，收到：${unknown.join("、") || "空"}`);

  return {
    out: resolve(out),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    sources: [...new Set(sources)] as SourceName[],
    ompRoot: resolve(pick("omp-root", "ompRoot") ?? omp.defaultRoot(home)),
    claudeRoot: resolve(pick("claude-root", "claudeRoot") ?? claudeCode.defaultRoot(home)),
    repoRoot: resolve(import.meta.dir, ".."),
  };
}

export function runRecap(o: RecapOptions): { recap: Recap; file: string } {
  if (isInside(o.out, o.repoRoot)) throw new Error(`输出目录 ${o.out} 位于本工具的代码仓库内；回顾页含私人会话信息，不能写进代码仓库`);
  const inputs: RecapInput[] = [];
  for (const name of o.sources) {
    const root = name === "omp" ? o.ompRoot : o.claudeRoot;
    for (const file of ADAPTERS[name].locate(root).files) inputs.push({ source: name, read: ADAPTERS[name].read(root, file, DEFAULT_LIMITS) });
  }
  const recap = computeRecap(inputs, { ...(o.from ? { from: o.from } : {}), ...(o.to ? { to: o.to } : {}) });
  mkdirSync(o.out, { recursive: true });
  const file = join(o.out, "recap.html");
  writeFileSync(file, renderRecap(recap));
  return { recap, file };
}

if (import.meta.main) {
  try {
    const { recap, file } = runRecap(resolveRecapOptions(process.argv.slice(2)));
    console.log(`会话 ${recap.sessions}，用户消息 ${recap.userMessages}，天数 ${recap.days.length}`);
    console.log(`输出：${file}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
