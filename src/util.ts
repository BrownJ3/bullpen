// Small helpers used across the server.

import { closeSync, openSync, readSync } from "node:fs";

/** Short text for a line or a summary: cut at n characters with "…". */
export const clip = (s: string | undefined, n: number): string => (!s ? "" : s.length > n ? `${s.slice(0, n)}…` : s);

/** Tool output kept in a chat: cut long output and say so. */
export const clipOutput = (s: string, n = 4000): string => (s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s);

/** Part of a file, without reading all of it (session files can be 100 MB+). */
export function readRange(file: string, from: number, length: number): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, from);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** The text of a JSON string's inside (as captured by a regex), unescaped; undefined if it isn't valid. */
export function unescapeJson(s: string): string | undefined {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return undefined;
  }
}
