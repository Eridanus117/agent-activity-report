// Detects clients whose records exist on this machine but are not read, so the report can
// say so. Only the clients listed here are checked; others are outside detection.

import { existsSync } from "node:fs";
import { join } from "node:path";

const KNOWN_UNSUPPORTED: { client: string; path: string[] }[] = [{ client: "codex", path: [".codex", "sessions"] }];

export function detectUnsupported(home: string): string[] {
  return KNOWN_UNSUPPORTED.filter((k) => existsSync(join(home, ...k.path))).map((k) => k.client);
}

export const CHECKED_UNSUPPORTED = KNOWN_UNSUPPORTED.map((k) => k.client);
