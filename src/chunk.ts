// Splits a session digest into chunks no larger than `maxChars`, cutting in front of
// main-session user messages so a chunk holds whole "user message and what followed" segments.

import type { DigestLine } from "./types.ts";

const cost = (l: DigestLine) => l.text.length + 1;
const total = (ls: DigestLine[]) => ls.reduce((n, l) => n + cost(l), 0);

export function chunkLines(lines: DigestLine[], maxChars: number): DigestLine[][] {
  const segments: DigestLine[][] = [];
  for (const line of lines) {
    const startsSegment = line.kind === "user" && !line.subagent;
    if (startsSegment || segments.length === 0) segments.push([]);
    segments.at(-1)!.push(line);
  }

  const chunks: DigestLine[][] = [];
  let current: DigestLine[] = [];
  let size = 0;
  const flush = () => {
    if (current.length) chunks.push(current);
    current = [];
    size = 0;
  };
  const add = (piece: DigestLine[], pieceSize: number) => {
    if (size + pieceSize > maxChars) flush();
    current.push(...piece);
    size += pieceSize;
  };

  for (const segment of segments) {
    const segmentSize = total(segment);
    if (segmentSize <= maxChars) add(segment, segmentSize);
    // A segment that cannot fit in any chunk is cut by lines instead.
    else for (const line of segment) add([line], cost(line));
  }
  flush();
  return chunks;
}
