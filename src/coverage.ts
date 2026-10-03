// Bookkeeping for the coverage list. Records counts and problems; makes no decisions.

import type { Selection } from "./select.ts";
import type { ActivityEvent, Digest, ReadResult } from "./types.ts";

export interface FileCoverage {
  file: string;
  source: string;
  status: "ok" | "read_failed";
  error?: string;
  /** Raw records parsed from the file. */
  records: number;
  /** Raw records whose timestamp falls on the day (after dropping duplicates). */
  inDay: number;
  badLines: number;
  noTimestamp: number;
  duplicates: number;
  /** Digest lines produced, by kind. */
  sent: Record<string, number>;
  /** Day records that were not sent, by raw record type. */
  notSent: Record<string, number>;
}

export function fileCoverage(source: string, read: ReadResult, selection: Selection): FileCoverage {
  const entry: FileCoverage = {
    file: read.file,
    source,
    status: read.error ? "read_failed" : "ok",
    records: read.parsed,
    inDay: new Set(selection.inDay.map((r) => r.line)).size,
    badLines: read.badLines,
    noTimestamp: selection.noTimestamp,
    duplicates: selection.duplicates,
    sent: {},
    notSent: {},
  };
  if (read.error) entry.error = read.error;
  for (const r of selection.inDay) {
    if (r.kind === "skipped") entry.notSent[r.rawType] = (entry.notSent[r.rawType] ?? 0) + 1;
    else entry.sent[r.kind] = (entry.sent[r.kind] ?? 0) + 1;
  }
  return entry;
}

/** Whether the file needs a line in the coverage list: it has day records or something went wrong. */
export const worthListing = (f: FileCoverage) => f.inDay > 0 || f.status !== "ok" || f.badLines > 0 || f.duplicates > 0;

export interface UncitedUserMessage {
  session: string;
  file: string;
  line: number;
}

/** Main-session user messages that no accepted event refers to. */
export function uncitedUserMessages(sessions: { label: string; digest: Digest }[], events: ActivityEvent[]): UncitedUserMessage[] {
  const out: UncitedUserMessage[] = [];
  for (const { label, digest } of sessions) {
    const cited = new Set(events.filter((e) => e.session === label).flatMap((e) => e.refs));
    for (const [ref, info] of digest.refs) {
      if (info.kind === "user" && !info.subagent && !cited.has(ref)) out.push({ session: label, file: info.file, line: info.line });
    }
  }
  return out;
}

export function largestItemShare(itemSizes: number[], totalEvents: number): number {
  if (!totalEvents || !itemSizes.length) return 0;
  return Math.round((Math.max(...itemSizes) / totalEvents) * 1000) / 1000;
}
