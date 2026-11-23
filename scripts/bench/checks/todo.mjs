import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, repo, run } from "./_t.mjs";

const file = join(mkdtempSync(join(tmpdir(), "bench-todo-")), "todos.json");
const todo = (...args) => {
  const r = spawnSync(process.execPath, [join(repo, "todo.js"), ...args], { cwd: repo, env: { ...process.env, TODO_FILE: file }, encoding: "utf8", timeout: 8000 });
  return { out: r.stdout.trim(), err: r.stderr.trim(), code: r.status };
};
const ok = (r, out) => { assert.equal(r.code, 0, r.err); assert.equal(r.out, out); };
const bad = (r, err) => { assert.equal(r.code, 1); assert.equal(r.err, err); };
// These run in order and build on each other, like a session at the terminal.
run([
  ["list when empty", () => ok(todo("list"), "No todos.")],
  ["add", () => ok(todo("add", "buy", "milk"), "Added 1: buy milk")],
  ["add a second and third", () => { ok(todo("add", "walk dog"), "Added 2: walk dog"); ok(todo("add", "call mum"), "Added 3: call mum"); }],
  ["list", () => ok(todo("list"), "[ ] 1: buy milk\n[ ] 2: walk dog\n[ ] 3: call mum")],
  ["done", () => ok(todo("done", "2"), "Done 2: walk dog")],
  ["list shows done", () => ok(todo("list"), "[ ] 1: buy milk\n[x] 2: walk dog\n[ ] 3: call mum")],
  ["list --pending", () => ok(todo("list", "--pending"), "[ ] 1: buy milk\n[ ] 3: call mum")],
  ["list --done", () => ok(todo("list", "--done"), "[x] 2: walk dog")],
  ["file is a JSON array of {id, text, done}", () => assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [
    { id: 1, text: "buy milk", done: false }, { id: 2, text: "walk dog", done: true }, { id: 3, text: "call mum", done: false }])],
  ["rm", () => ok(todo("rm", "1"), "Removed 1: buy milk")],
  ["next id is highest + 1", () => ok(todo("add", "new"), "Added 4: new")],
  ["clear-done", () => { ok(todo("clear-done"), "Cleared 1"); ok(todo("list"), "[ ] 3: call mum\n[ ] 4: new"); }],
  ["done: unknown id", () => bad(todo("done", "99"), "Error: no todo 99")],
  ["rm: unknown id", () => bad(todo("rm", "99"), "Error: no todo 99")],
  ["add: no text", () => bad(todo("add"), "Error: text required")],
  ["unknown command", () => bad(todo("frobnicate"), "Error: unknown command frobnicate")],
]);
