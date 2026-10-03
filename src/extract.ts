// Event extraction: prompt, parsing, validation of references, and the evidence review.

import { EVENT_TYPES } from "./types.ts";
import type { ActivityEvent, DigestLine, EventType, Evidence, ModelRunner, RefInfo, Rejection } from "./types.ts";

export function extractPrompt(day: string, title: string, lines: DigestLine[], earlier: string[]): string {
  const background = earlier.length
    ? `\n本会话此前已抽出的事件（只作背景，帮助理解上下文；不要重复输出它们）：\n${earlier.map((s) => `- ${s}`).join("\n")}\n`
    : "";
  return `任务：抽取事件

下面是一个 AI agent 会话在 ${day} 这一天的记录摘录。每行开头的 [rN] 是记录引用。
TOOL 行是 agent 的一次工具调用：工具名、意图、对象、结果（ok / ERROR / NO_RESULT）。成功的工具输出没有附上。
带 SUB 的行来自子 agent。

请抽取这一天里发生的事件，只依据摘录内容，不要猜测。每个事件输出一行独立的 JSON（JSONL），不要外层数组，不要代码块，不要别的文字：
{"type":"...","statement":"...","actor":"user|agent","evidence":"plan|attempt|evidenced","refs":["r12","r15"]}
如果摘录里没有任何值得记录的事件，只输出一行：{"none":true}

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
- 用户的简短答复（如「同意」「可以，推进」「按你推荐的来」）也是决定：记成 decision，statement 写清批准或否决的是哪一条推荐或方案（从前面 agent 的回复里找），给了推进范围（如「一直推进到终点」）的也写进去；refs 同时列出这条用户消息和那条推荐所在的记录。
- 用户叫停、改方向或说明不要做什么，记成 adjustment，statement 写清改成了什么。
- 相邻的多次工具调用如果属于同一件事，合成一个事件，refs 列出其中关键的几条。
- 不要把 agent 说“已完成”但没有工具结果支持的内容标成 evidenced。
${background}
会话标题：${title}
摘录：
${lines.map((l) => l.text).join("\n")}

只输出 JSONL，每行一个事件。`;
}

const EVIDENCE: readonly string[] = ["plan", "attempt", "evidenced"];

/** A reference can back "evidenced" only if it is a successful tool call or something the user did. */
const supports = (ref: RefInfo) =>
  ref.kind === "user" || ref.kind === "ask" || ref.kind === "todo_edit" || (ref.kind === "tool" && ref.toolOk === true);

function jsonLines(text: string): { ok: any[]; bad: string[] } {
  const ok: any[] = [];
  const bad: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/,$/, "");
    if (!line.startsWith("{")) continue;
    try {
      ok.push(JSON.parse(line));
    } catch {
      bad.push(line);
    }
  }
  return { ok, bad };
}

/** A reply is usable when it has at least one well-formed line, including the "none" placeholder. */
export const usableReply = (text: string) => jsonLines(text).ok.length > 0;

export function parseEvents(text: string, refs: Map<string, RefInfo>, session: string): { events: ActivityEvent[]; rejected: Rejection[] } {
  const events: ActivityEvent[] = [];
  const rejected: Rejection[] = [];
  const reject = (reason: string, detail: unknown) =>
    rejected.push({ stage: `extract ${session}`, reason, detail: (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 300) });

  const { ok, bad } = jsonLines(text);
  for (const line of bad) reject("malformed line", line);
  for (const o of ok) {
    if (o.none === true) continue;
    const cited: string[] = Array.isArray(o.refs) ? o.refs.map(String) : [];
    const unknown = cited.filter((r) => !refs.has(r));
    if (!cited.length) reject("no references", o);
    else if (unknown.length) reject(`unknown references ${unknown.join(", ")}`, o);
    else if (!(EVENT_TYPES as readonly string[]).includes(o.type)) reject(`unknown type ${String(o.type)}`, o);
    else if (!EVIDENCE.includes(o.evidence)) reject(`unknown evidence ${String(o.evidence)}`, o);
    else if (typeof o.statement !== "string" || !o.statement.trim()) reject("empty statement", o);
    else {
      const infos = cited.map((r) => refs.get(r)!);
      const actor = o.actor === "user" ? "user" : "agent";
      let evidence = o.evidence as Evidence;
      if (actor === "agent" && evidence === "evidenced" && !infos.some(supports)) evidence = "self_reported";
      const time = new Date(Math.min(...infos.map((i) => i.timestamp.getTime())));
      events.push({ id: "", session, type: o.type as EventType, statement: o.statement.trim(), actor, evidence, refs: cited, time });
    }
  }
  return { events, rejected };
}

export interface CallRecord {
  name: string;
  session: string;
  chars: number;
  ms: number;
  status: "ok" | "failed";
  attempts: number;
  cached: boolean;
  events?: number;
  error?: string;
}

export interface SessionJob {
  day: string;
  /** Short label used in the report, such as S3. */
  label: string;
  title: string;
  chunks: DigestLine[][];
  refs: Map<string, RefInfo>;
  runner: ModelRunner;
}

/** Chunks run in order so that each later chunk can be told what was already extracted. */
export async function extractSession(job: SessionJob): Promise<{ events: ActivityEvent[]; rejected: Rejection[]; calls: CallRecord[] }> {
  const events: ActivityEvent[] = [];
  const rejected: Rejection[] = [];
  const calls: CallRecord[] = [];
  for (const [i, chunk] of job.chunks.entries()) {
    const prompt = extractPrompt(job.day, job.title, chunk, events.map((e) => e.statement));
    const reply = await job.runner(prompt, usableReply);
    const call: CallRecord = {
      name: job.chunks.length > 1 ? `${job.label} ${i + 1}/${job.chunks.length}` : job.label,
      session: job.label,
      chars: chunk.reduce((n, l) => n + l.text.length + 1, 0),
      ms: reply.ms,
      status: reply.ok ? "ok" : "failed",
      attempts: reply.attempts,
      cached: reply.cached,
    };
    calls.push(call);
    if (!reply.ok) {
      if (reply.error) call.error = reply.error;
      continue;
    }
    const parsed = parseEvents(reply.text, job.refs, job.label);
    call.events = parsed.events.length;
    events.push(...parsed.events);
    rejected.push(...parsed.rejected);
  }
  return { events, rejected, calls };
}
