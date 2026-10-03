// Markdown for the overview and the itemized account.

import type { ActivityEvent, Item, RefInfo } from "./types.ts";

const TYPE: Record<string, string> = {
  request: "请求", adjustment: "调整", decision: "决定", exploration: "探索", completed: "完成",
  failed: "失败", cancelled: "取消", blocked: "阻塞", unfinished: "未完成",
};
const EVIDENCE: Record<string, string> = { plan: "计划", attempt: "尝试", evidenced: "有证据", self_reported: "仅 agent 自述" };
export const STATUS: Record<Item["status"], string> = {
  cancelled: "已取消", blocked: "阻塞", in_progress: "进行中", done: "已完成", self_reported_done: "自述完成，无证据",
};

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export interface OverviewInput {
  day: string;
  timezone: string;
  model: string;
  supported: string[];
  unsupported: string;
  filesScanned: number;
  sessions: number;
  readFailures: number;
  badLines: number;
  calls: number;
  failedSessions: { label: string; title: string }[];
  mergeFailed: boolean;
  events: number;
  rejected: number;
  unmerged: number;
  userMessages: number;
  uncited: number;
  overview: string;
  items: Item[];
}

export function renderOverview(o: OverviewInput): string {
  const failed = o.failedSessions.length
    ? o.failedSessions.map((s) => `\n- ${s.label}（${s.title || "无标题"}）：模型调用失败，相应内容未进入报告`).join("")
    : "";
  const merge = o.mergeFailed ? "\n- 事项归并调用失败，所有事件列在明细的「未归并事件」下" : "";
  const rows = o.items.map((it) => `| ${cell(it.title)} | ${STATUS[it.status]} | ${it.eventIds.length} |`).join("\n");
  return `# ${o.day} 工作回顾

时区 ${o.timezone} · 模型 ${o.model}

## 覆盖

- 已读取的来源：${o.supported.join("、")}；${o.unsupported}
- 扫描记录文件 ${o.filesScanned}，当日有记录的会话 ${o.sessions}，读取失败 ${o.readFailures}，无法解析的行 ${o.badLines}
- 模型调用 ${o.calls} 次${failed}${merge}
- 事件 ${o.events}，被拒 ${o.rejected}，未归并 ${o.unmerged}
- 用户消息被事件引用 ${o.userMessages - o.uncited} / ${o.userMessages}；未被引用的列在 coverage.json
- 详细状态见 coverage.json；事项与来源见 items.md

## 概览

${o.overview.trim() || "（概览生成失败）"}

## 事项

| 事项 | 状态 | 事件数 |
|---|---|---|
${rows}
`;
}

export interface ItemsInput {
  day: string;
  items: Item[];
  orphans: ActivityEvent[];
  events: Map<string, ActivityEvent>;
  /** Session label -> reference -> where it came from. */
  refs: Map<string, Map<string, RefInfo>>;
}

function eventLine(e: ActivityEvent, refs: Map<string, RefInfo>): string {
  const byFile = new Map<string, Set<number>>();
  for (const r of e.refs) {
    const info = refs.get(r);
    if (!info) continue;
    const where = `${info.source} ${info.file}`;
    if (!byFile.has(where)) byFile.set(where, new Set());
    byFile.get(where)!.add(info.line);
  }
  const src = [...byFile].map(([f, ls]) => `${f} 行 ${[...ls].sort((a, b) => a - b).join(", ")}`).join("；");
  const who = e.actor === "user" ? "用户" : `agent，${EVIDENCE[e.evidence]}`;
  return `- ${hhmm(e.time)} **${TYPE[e.type]}**（${who}）${e.statement}\n  - 来源 ${e.session}：${src}`;
}

export function renderItems(o: ItemsInput): string {
  const line = (e: ActivityEvent) => eventLine(e, o.refs.get(e.session) ?? new Map());
  let md = `# ${o.day} 事项明细\n`;
  for (const it of o.items) {
    const open = it.open.length ? `遗留：\n${it.open.map((x) => `- ${x}`).join("\n")}\n\n` : "";
    md += `\n## ${it.title}\n\n状态：${STATUS[it.status]}\n\n${it.summary}\n\n${open}${it.eventIds.map((id) => line(o.events.get(id)!)).join("\n")}\n`;
  }
  if (o.orphans.length) md += `\n## 未归并事件\n\n${o.orphans.map(line).join("\n")}\n`;
  return md;
}
