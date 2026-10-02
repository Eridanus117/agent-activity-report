// PROTOTYPE — not the product implementation. Answers one question:
// "what do we send to the model, and what do we get back?" for one day of omp sessions.
// Output goes to --out, which must be outside the repository (real session content).
//
//   bun run prototype/proto.ts --day 2026-10-01 --out <dir> [--dry] [--model <id>] [--root <omp sessions dir>]

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, sep, toNamespacedPath, resolve } from "node:path";
import { homedir } from "node:os";

const arg = (name: string, def?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const DAY = arg("day")!;
const OUT = arg("out")!;
const DRY = process.argv.includes("--dry");
const MODEL = arg("model", "openai-codex/gpt-6-luna")!;
const ROOT = resolve(arg("root", join(homedir(), ".omp", "agent", "sessions"))!);
const CHUNK = Number(arg("chunk", "350000"));
const CONCURRENCY = 4;
if (!DAY || !OUT) throw new Error("--day and --out are required");
if (resolve(OUT).startsWith(resolve(import.meta.dir, ".."))) throw new Error("--out must be outside the repository");

const lp = (p: string) => toNamespacedPath(p); // Windows paths over 260 chars
const cap = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}…(+${s.length - n})`);
const headTail = (s: string, n: number) =>
  s.length <= 2 * n ? s : `${s.slice(0, n)}\n…(${s.length - 2 * n} chars omitted)…\n${s.slice(-n)}`;
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const localDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const textOf = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("")
      : "";

// ---------- 1. inventory ----------
type FileCov = {
  file: string; status: "ok" | "read_failed"; error?: string;
  records: number; inDay: number; badLines: number; noTimestamp: number;
  sent: Record<string, number>; notSent: Record<string, number>;
};
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(lp(dir), { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}
const files = walk(ROOT).sort();
const groups = new Map<string, string[]>(); // main session key -> files (main first)
for (const f of files) {
  const parts = relative(ROOT, f).split(sep);
  const key = `${parts[0]}/${parts[1].replace(/\.jsonl$/, "")}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(f);
}

// ---------- 2. digest ----------
type Ref = { file: string; line: number; id?: string; kind?: string };
type Digest = { key: string; title: string; lines: string[]; refs: Map<string, Ref>; chars: Record<string, number> };
const coverage: FileCov[] = [];

function toolTarget(name: string, a: any): string {
  if (!a || typeof a !== "object") return "";
  switch (name) {
    case "read": case "write": case "glob": return String(a.path ?? "");
    case "grep": return `${a.pattern ?? ""} in ${a.path ?? ""}`;
    case "bash": return cap(oneLine(String(a.command ?? "")), 160);
    case "eval": return cap(oneLine(String(a.title ?? a.code ?? "")), 120);
    case "edit": return cap(oneLine(String(a.input ?? "")), 120);
    case "web_search": return cap(String(a.query ?? ""), 160);
    case "todo": return cap(JSON.stringify(a), 500);
    case "ask": return cap(JSON.stringify(a.questions ?? a), 1500);
    case "task": return cap(JSON.stringify(a.tasks ?? a), 800);
    case "yield": return cap(JSON.stringify(a), 600);
    default: return cap(JSON.stringify(a), 160);
  }
}

function digestGroup(key: string, gfiles: string[]): Digest {
  const dg: Digest = { key, title: "", lines: [], refs: new Map(), chars: {} };
  let n = 0;
  const add = (cat: string, ref: Ref, text: string, cov: FileCov) => {
    const r = `r${++n}`;
    dg.refs.set(r, { ...ref, kind: cat });
    const line = `[${r}] ${text}`;
    dg.lines.push(line);
    dg.chars[cat] = (dg.chars[cat] ?? 0) + line.length;
    cov.sent[cat] = (cov.sent[cat] ?? 0) + 1;
  };
  for (const f of gfiles) {
    const rel = relative(ROOT, f).split(sep).join("/");
    const cov: FileCov = { file: rel, status: "ok", records: 0, inDay: 0, badLines: 0, noTimestamp: 0, sent: {}, notSent: {} };
    coverage.push(cov);
    let raw: string;
    try { raw = readFileSync(lp(f), "utf8"); } catch (e: any) { cov.status = "read_failed"; cov.error = String(e?.code ?? e); continue; }
    const recs: { o: any; line: number }[] = [];
    raw.split("\n").forEach((l, i) => {
      if (!l.trim()) return;
      try { recs.push({ o: JSON.parse(l), line: i + 1 }); } catch { cov.badLines++; }
    });
    cov.records = recs.length;
    const results = new Map<string, any>();
    for (const { o } of recs) if (o?.message?.role === "toolResult") results.set(o.message.toolCallId, o.message);
    const isSub = rel.split("/").length > 2;
    let headerDone = false;
    for (const { o, line } of recs) {
      if (o.type === "session" && !dg.title && !isSub) dg.title = String(o.title ?? "");
      if (typeof o.timestamp !== "string") { cov.noTimestamp++; continue; }
      const d = new Date(o.timestamp);
      if (localDay(d) !== DAY) continue;
      cov.inDay++;
      const ref: Ref = { file: rel, line, id: o.id };
      const t = hhmm(d);
      const skip = (why: string) => { cov.notSent[why] = (cov.notSent[why] ?? 0) + 1; };
      if (isSub && !headerDone) { dg.lines.push(`--- SUBAGENT SESSION ${rel.split("/").slice(2).join("/")} ---`); headerDone = true; }
      const m = o.message;
      if (o.type === "session_init") add("subagent_task", ref, `${t} SUBAGENT_TASK(${o.agent ?? ""}): ${cap(String(o.task ?? ""), 1500)}`, cov);
      else if (o.type === "message" && m?.role === "user") add("user", ref, `${t} ${isSub ? "SUBAGENT_INPUT" : "USER"}: ${isSub ? cap(textOf(m.content), 1500) : textOf(m.content)}`, cov);
      else if (o.type === "message" && m?.role === "assistant") {
        let any = false;
        for (const b of Array.isArray(m.content) ? m.content : []) {
          if (b?.type === "text" && b.text?.trim()) { add("assistant", ref, `${t} ASSISTANT: ${b.text}`, cov); any = true; }
          else if (b?.type === "toolCall") {
            const res = results.get(b.id);
            const status = !res ? "NO_RESULT" : res.isError ? "ERROR" : "ok";
            let s = `${t} TOOL ${b.name}${b.intent ? ` (${cap(oneLine(String(b.intent)), 100)})` : ""}: ${toolTarget(b.name, b.arguments)} -> ${status}`;
            if (res?.isError) s += `\n    ERROR_OUTPUT: ${headTail(textOf(res.content), 300)}`;
            else if (res && b.name === "ask") s += `\n    ANSWER: ${cap(textOf(res.content), 1500)}`;
            add(res?.isError ? "tool_error" : b.name === "ask" ? "ask" : "tool", ref, s, cov); any = true;
          }
        }
        if (m.stopReason === "error" || m.stopReason === "aborted") { add("stop", ref, `${t} ASSISTANT_STOPPED: ${m.stopReason} ${cap(String(m.errorMessage ?? ""), 200)}`, cov); any = true; }
        if (!any) skip("assistant_thinking_only");
      }
      else if (o.type === "message" && m?.role === "toolResult") skip("tool_result_folded_into_call");
      else if (o.type === "custom" && o.customType === "user_todo_edit") add("todo_edit", ref, `${t} USER_EDITED_TODO: ${cap(JSON.stringify(o.data), 800)}`, cov);
      else if (o.type === "custom" && o.customType === "session_exit") add("exit", ref, `${t} SESSION_EXIT: ${o.data?.kind ?? ""} ${cap(String(o.data?.reason ?? ""), 200)}`, cov);
      else if (o.type === "compaction") add("compaction", ref, `${t} CONTEXT_COMPACTED (summary not included)`, cov);
      else if (o.type === "model_usage" && o.errorMessage) add("stop", ref, `${t} MODEL_ERROR: ${cap(String(o.errorMessage), 200)}`, cov);
      else skip(`${o.type}${o.customType ? `:${o.customType}` : ""}${m?.role ? `:${m.role}` : ""}`);
    }
  }
  return dg;
}

// ---------- 3. model ----------
async function callModel(name: string, prompt: string): Promise<{ text: string; ms: number; error?: string }> {
  const dir = join(OUT, "calls");
  mkdirSync(dir, { recursive: true });
  const pf = join(dir, `${name}.prompt.md`);
  writeFileSync(pf, prompt);
  const t0 = Date.now();
  const p = Bun.spawn(
    ["omp", "-p", "--no-session", "--no-tools", "--no-skills", "--no-rules", "--no-extensions", "--no-title",
      "--thinking", "low", "--model", MODEL, "--system-prompt", "You are a data extraction function. Output only JSON.", `@${pf}`],
    { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), 15 * 60_000);
  const [text, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  writeFileSync(join(dir, `${name}.response.txt`), text);
  return { text, ms: Date.now() - t0, error: code === 0 ? undefined : `exit ${code}: ${cap(err, 300)}` };
}
function parseJson(text: string): any {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON object in response");
  return JSON.parse(text.slice(a, b + 1));
}
async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}

const EXTRACT = `下面是一个 AI agent 会话在 ${DAY} 这一天的记录摘录。每行开头的 [rN] 是记录引用。
TOOL 行是 agent 的一次工具调用：工具名、意图、对象、结果（ok / ERROR / NO_RESULT）。成功的工具输出没有附上。

请抽取这一天里发生的事件，只依据摘录内容，不要猜测。每个事件输出一行独立的 JSON（JSONL），不要外层数组，不要代码块，不要别的文字：
{"type":"...","statement":"...","actor":"user|agent","evidence":"plan|attempt|evidenced","refs":["r12","r15"],"time":"HH:MM"}

type 取值：
- request：用户提出的任务或问题
- adjustment：用户修改、收窄或扩大了任务
- decision：用户作出的决定或选择（包括对 agent 提问的回答、批准、否决）
- exploration：调查、阅读、分析得到的发现
- completed：完成的工作结果
- failed：失败的尝试或报错
- cancelled：被取消或放弃的工作
- blocked：被卡住、等待外部条件或等待用户
- unfinished：到摘录结束时仍未完成或明确留待以后的事项

evidence 取值（只对 agent 的事件有意义；用户的事件一律写 evidenced）：
- plan：只是说了打算做
- attempt：有工具调用表明做了，但没有成功结果作证
- evidenced：有成功的工具结果或用户确认作证（例如测试命令 ok、提交 ok、用户说可以）

要求：
- statement 用中文写一句具体的话，说清对象（哪个文件、哪个功能、哪个问题），不写空话。
- refs 必须是摘录里真实出现的引用，每个事件至少一个。
- 用户的每一条实质性请求、调整和决定都要有对应事件，不要因为琐碎而省略；每条 USER 行的引用至少要出现在一个事件的 refs 里。
- 相邻的多次工具调用如果属于同一件事，合成一个事件，refs 列出其中关键的几条。
- 不要把 agent 说“已完成”但没有工具结果支持的内容标成 evidenced。

摘录：
`;

type Ev = { id: string; session: string; type: string; statement: string; actor: string; evidence: string; refs: string[]; time: string };

async function main() {
  mkdirSync(OUT, { recursive: true });
  const digests: Digest[] = [];
  for (const [key, gf] of groups) {
    const dg = digestGroup(key, gf);
    if (dg.refs.size) digests.push(dg);
  }
  const tot: Record<string, number> = {};
  for (const d of digests) for (const [k, v] of Object.entries(d.chars)) tot[k] = (tot[k] ?? 0) + v;
  const sum = Object.values(tot).reduce((a, b) => a + b, 0);
  console.log(`files ${files.length}, sessions with records on ${DAY}: ${digests.length}, read failures: ${coverage.filter((c) => c.status !== "ok").length}`);
  console.log("chars to send by category:", tot, "total", sum);
  mkdirSync(join(OUT, "digests"), { recursive: true });
  digests.forEach((d, i) => writeFileSync(join(OUT, "digests", `S${i + 1}.md`), `SESSION ${d.title}\n${d.lines.join("\n")}\n`));
  const cov = { day: DAY, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, source: "omp", unsupportedSources: ["claude-code", "codex", "others"], model: MODEL, charsSent: tot, files: coverage.filter((c) => c.inDay > 0 || c.status !== "ok" || c.badLines > 0), filesScanned: files.length, calls: [] as any[], rejected: [] as any[] };
  if (DRY) { writeFileSync(join(OUT, "coverage.json"), JSON.stringify(cov, null, 2)); return; }

  // per-session extraction
  const events: Ev[] = [];
  await pool(digests, CONCURRENCY, async (d, i) => {
    const chunks: string[][] = [[]];
    let size = 0;
    for (const l of d.lines) { if (size + l.length > CHUNK && chunks.at(-1)!.length) { chunks.push([]); size = 0; } chunks.at(-1)!.push(l); size += l.length; }
    for (let c = 0; c < chunks.length; c++) {
      const name = `S${i + 1}${chunks.length > 1 ? `_${c + 1}` : ""}`;
      const r = await callModel(name, `${EXTRACT}SESSION ${d.title}\n${chunks[c].join("\n")}\n\n只输出 JSONL，每行一个事件。`);
      const call: any = { name, session: d.key, chars: chunks[c].join("\n").length, ms: r.ms, status: "ok" };
      cov.calls.push(call);
      if (r.error) { call.status = "call_failed"; call.error = r.error; continue; }
      const evs: any[] = [];
      for (const l of r.text.split("\n")) {
        const s = l.trim();
        if (!s.startsWith("{")) continue;
        try { evs.push(JSON.parse(s.replace(/,$/, ""))); } catch { cov.rejected.push({ call: name, reason: "malformed line", line: cap(s, 200) }); }
      }
      if (!evs.length) { call.status = "parse_failed"; continue; }
      call.events = evs.length;
      for (const e of evs) {
        const refs = (Array.isArray(e.refs) ? e.refs : []).map(String);
        const bad = refs.filter((x: string) => !d.refs.has(x));
        if (!refs.length || bad.length) { cov.rejected.push({ call: name, reason: refs.length ? `unknown refs ${bad.join(",")}` : "no refs", event: e }); continue; }
        // "evidenced" must rest on a successful tool call or a user record, not on the agent's own words
        const kinds = refs.map((x: string) => d.refs.get(x)!.kind);
        if (e.actor !== "user" && e.evidence === "evidenced" && !kinds.some((k: any) => ["tool", "ask", "user", "todo_edit"].includes(k))) e.evidence = "self_reported";
        events.push({ id: "", session: `S${i + 1}`, type: String(e.type), statement: String(e.statement), actor: String(e.actor), evidence: String(e.evidence), refs, time: String(e.time ?? "") });
      }
      console.log(`${name}: ${call.status} ${call.events ?? 0} events, ${Math.round(r.ms / 1000)}s`);
    }
  });
  // mechanical check: which main-session user records are cited by no event
  const userCov = digests.map((d, i) => {
    const cited = new Set(events.filter((e) => e.session === `S${i + 1}`).flatMap((e) => e.refs));
    const users = [...d.refs].filter(([, x]) => x.kind === "user" && x.file.split("/").length === 2).map(([r]) => r);
    return { session: `S${i + 1}`, userRecords: users.length, cited: users.filter((r) => cited.has(r)).length, uncited: users.filter((r) => !cited.has(r)).map((r) => `${d.refs.get(r)!.file}:${d.refs.get(r)!.line}`) };
  });
  Object.assign(cov, { userRecordCoverage: userCov });
  events.sort((a, b) => (a.time + a.session).localeCompare(b.time + b.session));
  events.forEach((e, i) => (e.id = `e${i + 1}`));

  // cross-session merge
  const list = events.map((e) => `${e.id} | ${e.session} ${cap(digests[Number(e.session.slice(1)) - 1].title, 40)} | ${e.time} | ${e.type} | ${e.evidence} | ${e.statement}`).join("\n");
  const MERGE = `下面是 ${DAY} 这一天从多个 AI agent 会话里抽出的事件，每行：事件编号 | 会话 | 时间 | 类型 | 证据等级 | 陈述。
请把它们归并成“事项”（一件独立的工作或话题，可以跨会话），并写一段当日概览。输出一个 JSON 对象，不要输出别的：
{"items":[{"title":"...","status":"done|in_progress|blocked|cancelled|failed|unknown","summary":"一到两句：做了什么、到哪一步","event_ids":["e1","e7"],"open":["还没做完或待决定的具体事"]}],"overview":"markdown，先一段总述，再按重要性列出要点"}
要求：
- 每个事件编号必须且只能归入一个事项，不要丢事件。
- 不同的任务不要硬并成一个事项；同一事项里后来的决定变更要在 summary 里说出来，不要只留最后结果。
- status 依据事件的类型和证据等级判断；只有 evidenced 的 completed 事件支持时才写 done。
- 全部用中文。

事件：
${list}

只输出 JSON。`;
  const mr = await callModel("merge", MERGE);
  let items: any[] = [], overview = "";
  const mcall: any = { name: "merge", chars: list.length, ms: mr.ms, status: "ok" };
  cov.calls.push(mcall);
  try { if (mr.error) throw new Error(mr.error); const j = parseJson(mr.text); items = j.items ?? []; overview = String(j.overview ?? ""); } catch (e: any) { mcall.status = "failed"; mcall.error = String(e.message); }
  const byId = new Map(events.map((e) => [e.id, e]));
  const used = new Map<string, number>();
  for (const it of items) { it.event_ids = (it.event_ids ?? []).map(String).filter((x: string) => byId.has(x) || (cov.rejected.push({ call: "merge", reason: `unknown event ${x}` }), false)); for (const x of it.event_ids) used.set(x, (used.get(x) ?? 0) + 1); }
  const orphan = events.filter((e) => !used.has(e.id));
  const dup = [...used].filter(([, c]) => c > 1).map(([k]) => k);
  Object.assign(cov, { events: events.length, items: items.length, eventsNotAssignedByMerge: orphan.length, eventsAssignedMoreThanOnce: dup.length });

  // render
  const label: Record<string, string> = { request: "请求", adjustment: "调整", decision: "决定", exploration: "探索", completed: "完成", failed: "失败", cancelled: "取消", blocked: "阻塞", unfinished: "未完成", plan: "计划", attempt: "尝试", evidenced: "有证据", self_reported: "仅 agent 自述", done: "已完成", in_progress: "进行中", unknown: "不明" };
  const L = (s: string) => label[s] ?? s;
  const evLine = (e: Ev) => {
    const d = digests[Number(e.session.slice(1)) - 1];
    const byFile = new Map<string, Set<number>>();
    for (const r of e.refs) { const x = d.refs.get(r)!; if (!byFile.has(x.file)) byFile.set(x.file, new Set()); byFile.get(x.file)!.add(x.line); }
    const src = [...byFile].map(([f, ls]) => `${f} 行 ${[...ls].sort((a, b) => a - b).join(", ")}`).join("; ");
    return `- ${e.time} **${L(e.type)}**（${e.actor === "user" ? "用户" : `agent，${L(e.evidence)}`}）${e.statement}\n  - 来源 ${e.session}：${src}`;
  };
  const failedCalls = cov.calls.filter((c) => c.status !== "ok");
  let ov = `# ${DAY} 工作回顾（原型）\n\n时区 ${cov.timezone} · 来源 omp · 模型 ${MODEL}\n\n## 覆盖\n\n- 扫描文件 ${files.length}，当日有记录的会话 ${digests.length}，读取失败 ${coverage.filter((c) => c.status !== "ok").length}，坏行 ${coverage.reduce((a, c) => a + c.badLines, 0)}\n- 模型调用 ${cov.calls.length}，失败 ${failedCalls.length}${failedCalls.length ? `（${failedCalls.map((c) => c.name).join(", ")}，这些会话的内容未进入报告）` : ""}\n- 用户消息被事件引用 ${userCov.reduce((a, c) => a + c.cited, 0)} / ${userCov.reduce((a, c) => a + c.userRecords, 0)}（机械统计，未被引用的列在 coverage.json）\n- 事件 ${events.length}，被拒（引用无效或格式坏）${cov.rejected.length}，未被归并 ${orphan.length}\n- 未支持来源：Claude Code、Codex 及其他客户端\n\n## 概览\n\n${overview}\n\n## 事项\n\n| 事项 | 状态 | 事件数 |\n|---|---|---|\n${items.map((it) => `| ${it.title} | ${L(it.status)} | ${it.event_ids.length} |`).join("\n")}\n`;
  let md = `# ${DAY} 事项明细（原型）\n`;
  for (const it of items) md += `\n## ${it.title}\n\n状态：${L(it.status)}\n\n${it.summary ?? ""}\n\n${(it.open ?? []).length ? `遗留：\n${it.open.map((o: string) => `- ${o}`).join("\n")}\n\n` : ""}${it.event_ids.map((x: string) => evLine(byId.get(x)!)).join("\n")}\n`;
  if (orphan.length) md += `\n## 未归并事件\n\n${orphan.map(evLine).join("\n")}\n`;
  writeFileSync(join(OUT, "overview.md"), ov);
  writeFileSync(join(OUT, "items.md"), md);
  writeFileSync(join(OUT, "events.json"), JSON.stringify(events, null, 2));
  writeFileSync(join(OUT, "coverage.json"), JSON.stringify(cov, null, 2));
  console.log(`events ${events.length}, rejected ${cov.rejected.length}, items ${items.length}, orphan ${orphan.length}, dup ${dup.length}, failed calls ${failedCalls.length}`);
}
await main();
