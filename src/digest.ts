// Turns the day's records of one session into the text lines sent to the model,
// and remembers which raw record each reference points to.

import type { Digest, Kind, SourceRecord } from "./types.ts";

const LABEL: Record<Exclude<Kind, "skipped">, string> = {
  user: "USER",
  ask: "ASK",
  todo_edit: "USER_EDITED_TODO",
  tool: "TOOL",
  tool_error: "TOOL",
  assistant: "ASSISTANT",
  subagent_task: "SUBAGENT_TASK",
  stop: "STOP",
  marker: "MARKER",
};

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** Records must carry a timestamp; callers pass the output of selectDay. */
export function buildDigest(records: SourceRecord[]): Digest {
  const digest: Digest = { lines: [], refs: new Map() };
  const sendable = records.filter((r) => r.kind !== "skipped" && r.timestamp);
  // Array.prototype.sort is stable, so records with equal timestamps keep their file order.
  sendable.sort((a, b) => a.timestamp!.getTime() - b.timestamp!.getTime());
  sendable.forEach((r, i) => {
    const ref = `r${i + 1}`;
    const kind = r.kind as Exclude<Kind, "skipped">;
    const label = `${r.subagent ? "SUB " : ""}${LABEL[kind]}`;
    digest.lines.push({ ref, kind, subagent: r.subagent, text: `[${ref}] ${hhmm(r.timestamp!)} ${label}: ${r.text}` });
    digest.refs.set(ref, {
      file: r.file,
      line: r.line,
      kind,
      subagent: r.subagent,
      timestamp: r.timestamp!,
      ...(r.id !== undefined ? { id: r.id } : {}),
      ...(r.toolOk !== undefined ? { toolOk: r.toolOk } : {}),
    });
  });
  return digest;
}
