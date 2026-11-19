// What the harness tools (src/tools/*) get from the orchestrator.

import type { Artifacts } from "../artifacts.ts";
import type { BrowserHub } from "../browser.ts";
import type { Store } from "../store.ts";
import type { Command, Thread } from "../types.ts";

export interface ToolContext {
  store: Store;
  artifacts: Artifacts;
  browser: BrowserHub;
  requireThread(id: string): Thread;
  /** The project folder a chat's current work is in. */
  projectOf(threadId: string): string | undefined;
  transcript(threadId: string): string;
  waitFor(threadId: string, done: () => boolean): Promise<void>;
  dispatch(command: Command): Promise<unknown>;
  startAgentThread(callerThreadId: string, caller: Thread, root: string, args: Record<string, string>): Promise<Thread>;
}
