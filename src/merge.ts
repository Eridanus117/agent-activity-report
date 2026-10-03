// Item merging: the model only groups events; status is decided by rule (status.ts),
// and the overview is written afterwards from the items and their decided statuses.

import type { ActivityEvent, Item, Rejection } from "./types.ts";

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export function mergePrompt(day: string, events: ActivityEvent[], titles: Map<string, string>): string {
  const list = events
    .map((e) => `${e.id} | ${e.session} ${(titles.get(e.session) ?? "").slice(0, 40)} | ${hhmm(e.time)} | ${e.type} | ${e.actor} | ${e.statement}`)
    .join("\n");
  return `任务：归并事项

下面是 ${day} 这一天从多个 AI agent 会话里抽出的事件，每行：事件编号 | 会话 | 时间 | 类型 | 行为人 | 陈述。
请把它们归并成“事项”。每个事项输出一行独立的 JSON（JSONL），不要外层数组，不要代码块，不要别的文字：
{"title":"...","summary":"一到两句：做了什么、到哪一步","event_ids":["e1","e7"],"open":["还没做完或待决定的具体事"]}

要求：
- 一个事项对应一件可独立交付的工作或一个独立的问题；同一会话通常会产生多个事项，可以跨会话合并同一件事。
- 不同的任务不要硬并成一个事项；同一事项里后来的决定变更要在 summary 里说出来，不要只留最后结果。
- 每个事件编号必须且只能归入一个事项，不要丢事件。
- 不要输出状态，状态由程序判定。
- 全部用中文。

事件：
${list}

只输出 JSONL，每行一个事项。`;
}

export interface RawItem {
  title: string;
  summary: string;
  eventIds: string[];
  open: string[];
}

export function parseItems(text: string, ids: Set<string>): { items: RawItem[]; rejected: Rejection[] } {
  const items: RawItem[] = [];
  const rejected: Rejection[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/,$/, "");
    if (!line.startsWith("{")) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      rejected.push({ stage: "merge", reason: "malformed line", detail: line.slice(0, 300) });
      continue;
    }
    const cited: string[] = Array.isArray(o.event_ids) ? o.event_ids.map(String) : [];
    const unknown = cited.filter((id) => !ids.has(id));
    if (unknown.length) rejected.push({ stage: "merge", reason: `unknown events ${unknown.join(", ")}`, detail: String(o.title ?? "").slice(0, 300) });
    items.push({
      title: String(o.title ?? "").trim() || "（无标题）",
      summary: String(o.summary ?? "").trim(),
      eventIds: cited.filter((id) => ids.has(id)),
      open: Array.isArray(o.open) ? o.open.map(String) : [],
    });
  }
  return { items, rejected };
}

export function usableItems(text: string): boolean {
  return text.split("\n").some((l) => {
    const line = l.trim().replace(/,$/, "");
    if (!line.startsWith("{")) return false;
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Every event ends up in exactly one item or in the orphan list. An event the model put in
 * several items stays in the first; items left with no events are dropped.
 */
export function reconcile(items: RawItem[], events: ActivityEvent[]): { items: RawItem[]; orphans: ActivityEvent[]; duplicates: number } {
  const placed = new Set<string>();
  let duplicates = 0;
  const kept: RawItem[] = [];
  for (const item of items) {
    const own = item.eventIds.filter((id) => {
      if (placed.has(id)) {
        duplicates++;
        return false;
      }
      placed.add(id);
      return true;
    });
    if (own.length) kept.push({ ...item, eventIds: own });
  }
  return { items: kept, orphans: events.filter((e) => !placed.has(e.id)), duplicates };
}

/**
 * Second pass for events the merge left out. With many events in one call the model can drop
 * whole runs of them; this asks only about those, against the items already formed.
 */
export function fillPrompt(day: string, leftOut: ActivityEvent[], items: { title: string; summary: string }[], titles: Map<string, string>): string {
  const itemList = items.map((it, i) => `${i + 1}. ${it.title}：${it.summary}`).join("\n");
  const list = leftOut
    .map((e) => `${e.id} | ${e.session} ${(titles.get(e.session) ?? "").slice(0, 40)} | ${hhmm(e.time)} | ${e.type} | ${e.actor} | ${e.statement}`)
    .join("\n");
  return `任务：补充归并

${day} 这一天的事件已经归并成下列事项，但还有一些事件没有归入任何事项。请把每个遗漏的事件归入最合适的已有事项，或者在它确实是另一件事时新开事项。
每行输出一个 JSON（JSONL），不要外层数组，不要代码块，不要别的文字：
- 归入已有事项：{"item":事项序号,"event_ids":["e40","e41"]}
- 新开事项：{"title":"...","summary":"一到两句：做了什么、到哪一步","event_ids":["e60"],"open":["还没做完或待决定的具体事"]}

要求：每个遗漏的事件编号必须且只能出现一次；不要列出不在遗漏列表里的事件；全部用中文。

已有事项：
${itemList}

遗漏的事件（每行：事件编号 | 会话 | 时间 | 类型 | 行为人 | 陈述）：
${list}

只输出 JSONL。`;
}

export function parseFill(
  text: string,
  leftOut: Set<string>,
  itemCount: number,
): { additions: { item: number; eventIds: string[] }[]; newItems: RawItem[]; rejected: Rejection[] } {
  const additions: { item: number; eventIds: string[] }[] = [];
  const newItems: RawItem[] = [];
  const rejected: Rejection[] = [];
  const reject = (reason: string, detail: string) => rejected.push({ stage: "merge fill", reason, detail: detail.slice(0, 300) });
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/,$/, "");
    if (!line.startsWith("{")) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      reject("malformed line", line);
      continue;
    }
    const cited: string[] = Array.isArray(o.event_ids) ? o.event_ids.map(String) : [];
    for (const id of cited.filter((id) => !leftOut.has(id))) reject(`not a left-out event ${id}`, line);
    const ids = cited.filter((id) => leftOut.has(id));
    if (o.item !== undefined) {
      const n = Number(o.item);
      if (!Number.isInteger(n) || n < 1 || n > itemCount) reject(`item number out of range ${String(o.item)}`, line);
      else if (ids.length) additions.push({ item: n, eventIds: ids });
    } else if (ids.length) {
      newItems.push({
        title: String(o.title ?? "").trim() || "（无标题）",
        summary: String(o.summary ?? "").trim(),
        eventIds: ids,
        open: Array.isArray(o.open) ? o.open.map(String) : [],
      });
    }
  }
  return { additions, newItems, rejected };
}

const STATUS_TEXT: Record<Item["status"], string> = {
  cancelled: "已取消",
  blocked: "阻塞",
  in_progress: "进行中",
  done: "已完成",
  self_reported_done: "自述完成，无证据",
};

export function overviewPrompt(day: string, items: Item[]): string {
  const list = items.map((it, i) => `${i + 1}. ${it.title}（${STATUS_TEXT[it.status]}）：${it.summary}${it.open.length ? ` 遗留：${it.open.join("；")}` : ""}`).join("\n");
  return `任务：写概览

下面是 ${day} 这一天的工作事项，括号里是程序依据事件判定的状态。请用中文写一段当日概览：先一段总述，再按重要性列出要点。
要求：只依据下列事项，不补充、不推测；状态照括号里的写，不要改写成别的状态。直接输出 Markdown 正文，不要标题。

事项：
${list}`;
}
