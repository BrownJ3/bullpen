// Team limits, and recognising and waiting out a plan's usage limit.

export const LIMITS = {
  maxTasks: 12, // per round
  maxParallel: 3, // tasks working at once per goal
  /** Each run of a task gets this long; then it wraps up and submits what it has (nothing is thrown away). */
  taskBudgetMs: Number(process.env.BULLPEN_TASK_BUDGET_MS) || 12 * 60_000,
  /** The wrap-up turn after the budget; past this it's stopped. */
  wrapUpMs: Number(process.env.BULLPEN_WRAPUP_MS) || 4 * 60_000,
  /** Improvement rounds for open-ended goals ("keep improving until…"). */
  defaultRounds: 5,
  maxRounds: 10,
  maxAttempts: 2, // one automatic retry, then park
  maxLeadTurns: 30, // per goal (more for goals with several rounds)
  maxNudges: 3, // "you still need to review / finish" re-wakes in a row
  sweepMs: 30_000,
  /** Hold a review wake-up this long while other tasks are about to submit, so one lead turn reviews them all. */
  reviewBatchMs: 45_000,
  pauseDefaultMs: 15 * 60_000, // when a usage limit doesn't say when it resets
};

const LIMIT_RE = /usage limit|rate.?limit|limit (reached|exceeded)|too many requests|\b429\b|quota|overloaded/i;

export function isLimitError(text: string): boolean {
  return LIMIT_RE.test(text);
}

/** When to try again after a usage limit: "resets 3pm" / "resets at 15:00" if the message says, else 15 minutes. */
export function resumeTime(text: string): string {
  const m = text.match(/reset[s]?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  const t = new Date();
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    if (m[3]) h = (h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
    const at = new Date(t);
    at.setHours(h, min + 1, 0, 0);
    if (at <= t) at.setDate(at.getDate() + 1);
    if (at.getTime() - t.getTime() < 12 * 3600_000) return at.toISOString();
  }
  return new Date(t.getTime() + LIMITS.pauseDefaultMs).toISOString();
}
