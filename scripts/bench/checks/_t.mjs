// Tiny check runner for the benchmark. Each check file calls run(repo => [[name, fn], ...]) and prints one RESULT line.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

export { assert };
export const repo = process.argv[2];
/** Import a module the agents wrote. */
export const load = (rel) => import(pathToFileURL(join(repo, rel)).href);
export const throws = (fn, type) => assert.throws(fn, (e) => e instanceof type);

export async function run(tests) {
  const failed = [];
  for (const [name, fn] of tests) {
    try {
      await Promise.race([Promise.resolve().then(fn), new Promise((_, r) => setTimeout(() => r(new Error("timed out")), 10_000))]);
    } catch (e) {
      failed.push(`${name}: ${String(e?.message ?? e).split("\n")[0].slice(0, 120)}`);
    }
  }
  console.log(`RESULT ${JSON.stringify({ total: tests.length, passed: tests.length - failed.length, failed })}`);
  process.exit(0);
}
