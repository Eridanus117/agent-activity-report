// Shapes shared across modules. See docs/changes/1/sdd.md.

export type Kind =
  | "user"
  | "ask"
  | "todo_edit"
  | "tool"
  | "tool_error"
  | "assistant"
  | "subagent_task"
  | "stop"
  | "marker"
  | "skipped";

/** One unit translated from a raw session record. A raw line can yield several. */
export interface SourceRecord {
  source: string;
  /** Main session key; subagent records carry the key of the session they belong to. */
  session: string;
  /** Path relative to the source root, with forward slashes. */
  file: string;
  line: number;
  id?: string;
  timestamp?: Date;
  subagent: boolean;
  kind: Kind;
  /** Text that goes into the digest, already truncated. Empty for skipped records. */
  text: string;
  /** Only for kind "tool": whether the call has a successful result. */
  toolOk?: boolean;
  /** Raw record type, used to count what was not sent. */
  rawType: string;
}

export interface Limits {
  intent: number;
  command: number;
  errorHeadTail: number;
  ask: number;
  subagentTask: number;
  todo: number;
  todoEdit: number;
  other: number;
  stopMessage: number;
}

export const DEFAULT_LIMITS: Limits = {
  intent: 100,
  command: 160,
  errorHeadTail: 300,
  ask: 1500,
  subagentTask: 1500,
  todo: 500,
  todoEdit: 800,
  other: 160,
  stopMessage: 200,
};

export interface ReadResult {
  file: string;
  session: string;
  title?: string;
  records: SourceRecord[];
  /** Raw lines that parsed as records. */
  parsed: number;
  badLines: number;
  error?: string;
}

export interface LocateResult {
  root: string;
  exists: boolean;
  files: string[];
  /** Directories that could not be listed. */
  errors: { path: string; error: string }[];
}

export interface RefInfo {
  file: string;
  line: number;
  id?: string;
  kind: Kind;
  toolOk?: boolean;
  subagent: boolean;
  timestamp: Date;
}

export interface DigestLine {
  ref: string;
  kind: Kind;
  subagent: boolean;
  text: string;
}

export interface Digest {
  lines: DigestLine[];
  refs: Map<string, RefInfo>;
}

export const EVENT_TYPES = [
  "request",
  "adjustment",
  "decision",
  "exploration",
  "completed",
  "failed",
  "cancelled",
  "blocked",
  "unfinished",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type Evidence = "plan" | "attempt" | "evidenced" | "self_reported";

export interface ActivityEvent {
  id: string;
  session: string;
  type: EventType;
  statement: string;
  actor: "user" | "agent";
  evidence: Evidence;
  refs: string[];
  time: Date;
}

export interface Rejection {
  stage: string;
  reason: string;
  detail: string;
}

export type ItemStatus = "cancelled" | "blocked" | "in_progress" | "done" | "self_reported_done";

export interface Item {
  title: string;
  summary: string;
  eventIds: string[];
  open: string[];
  status: ItemStatus;
}

export interface ModelResult {
  ok: boolean;
  text: string;
  ms: number;
  attempts: number;
  cached: boolean;
  error?: string;
}

/** Runs one prompt. `accept` decides whether a reply is usable; unusable replies are retried. */
export type ModelRunner = (prompt: string, accept: (text: string) => boolean) => Promise<ModelResult>;
