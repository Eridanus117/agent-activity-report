// Item status is decided by rule from the item's events, so the same events always
// give the same status. Rules are tried top to bottom; see docs/changes/1/sdd.md.

import type { ActivityEvent, ItemStatus } from "./types.ts";

/** `events` must be in time order. */
export function itemStatus(events: ActivityEvent[]): ItemStatus {
  const last = (type: string) => events.findLastIndex((e) => e.type === type);
  const lastCompleted = last("completed");

  const lastCancelled = last("cancelled");
  if (lastCancelled >= 0 && lastCompleted < lastCancelled) return "cancelled";

  if (events.some((e, i) => e.type === "blocked" && lastCompleted < i)) return "blocked";

  const lastFailed = last("failed");
  if (last("unfinished") >= 0 || (lastFailed >= 0 && lastCompleted < lastFailed)) return "in_progress";

  const completed = events.filter((e) => e.type === "completed");
  if (completed.some((e) => e.evidence === "evidenced")) return "done";
  if (completed.length) return "self_reported_done";
  return "in_progress";
}
