// Data directory (T3 home = ~/.t3). Holds the SQLite DB and the local auth token.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = process.env.BULLPEN_HOME ?? join(homedir(), ".bullpen");
export const DB_PATH = join(HOME, "state.sqlite");
const TOKEN_PATH = join(HOME, "token");

export function ensureHome() {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
}

/** Bearer token required on every WS connection. Created once, readable only by this user. */
export function loadOrCreateToken(): string {
  ensureHome();
  if (!existsSync(TOKEN_PATH)) {
    writeFileSync(TOKEN_PATH, randomBytes(32).toString("hex"), { mode: 0o600 });
  }
  chmodSync(TOKEN_PATH, 0o600);
  return readFileSync(TOKEN_PATH, "utf8").trim();
}

export function readToken(): string {
  return readFileSync(TOKEN_PATH, "utf8").trim();
}
