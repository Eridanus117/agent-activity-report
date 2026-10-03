// Picks the records of one local calendar day and drops records already seen elsewhere.

import type { SourceRecord } from "./types.ts";

export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface Selection {
  inDay: SourceRecord[];
  noTimestamp: number;
  duplicates: number;
}

/**
 * `seen` maps a record id to the raw line it was first found on, and is shared across the
 * files of one source. A raw line can yield several records with the same id; those are
 * not duplicates of each other.
 */
export function selectDay(records: SourceRecord[], day: string, seen: Map<string, string>): Selection {
  const out: Selection = { inDay: [], noTimestamp: 0, duplicates: 0 };
  const counted = new Set<string>();
  for (const r of records) {
    const where = `${r.file}:${r.line}`;
    if (!r.timestamp) {
      if (!counted.has(where)) out.noTimestamp++;
      counted.add(where);
      continue;
    }
    if (localDay(r.timestamp) !== day) continue;
    if (r.id !== undefined) {
      const key = `${r.source}:${r.id}`;
      const first = seen.get(key);
      if (first === undefined) seen.set(key, where);
      else if (first !== where) {
        if (!counted.has(where)) out.duplicates++;
        counted.add(where);
        continue;
      }
    }
    out.inDay.push(r);
  }
  return out;
}
