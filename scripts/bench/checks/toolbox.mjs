import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, load, repo, run, throws } from "./_t.mjs";
import { bytesTests, durationTests, slugifyTests, wrapTests } from "./_text.mjs";
const eq = assert.deepEqual;
const NAMES = ["slugify", "wordWrap", "parseDuration", "formatBytes", "deepMerge", "chunk", "parseCsv", "template"];
const merge = () => load("src/merge.js"), chunk = () => load("src/chunk.js"), csv = () => load("src/csv.js"), tpl = () => load("src/template.js");
run([
  ...slugifyTests(() => load("src/slugify.js")),
  ...wrapTests(() => load("src/wrap.js")),
  ...durationTests(() => load("src/duration.js")),
  ...bytesTests(() => load("src/bytes.js")),
  ["deepMerge: nested", async () => eq((await merge()).deepMerge({ a: { x: 1, y: 2 }, k: 1 }, { a: { y: 3, z: 4 } }), { a: { x: 1, y: 3, z: 4 }, k: 1 })],
  ["deepMerge: arrays are replaced", async () => eq((await merge()).deepMerge({ a: [1, 2, 3] }, { a: [9] }), { a: [9] })],
  ["deepMerge: null overwrites, undefined is skipped", async () => eq((await merge()).deepMerge({ a: 1, b: 2 }, { a: null, b: undefined }), { a: null, b: 2 })],
  ["deepMerge: does not mutate", async () => {
    const a = { n: { x: 1 } }, b = { n: { y: 2 } };
    const out = (await merge()).deepMerge(a, b);
    eq(a, { n: { x: 1 } }); eq(b, { n: { y: 2 } });
    out.n.x = 5; assert.equal(a.n.x, 1);
  }],
  ["deepMerge: object replaces a non-object", async () => eq((await merge()).deepMerge({ a: 1 }, { a: { b: 2 } }), { a: { b: 2 } })],
  ["chunk: basic", async () => eq((await chunk()).chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])],
  ["chunk: empty", async () => eq((await chunk()).chunk([], 3), [])],
  ["chunk: size larger than the array", async () => eq((await chunk()).chunk([1, 2], 5), [[1, 2]])],
  ["chunk: bad size throws RangeError", async () => { const m = await chunk(); throws(() => m.chunk([1], 0), RangeError); throws(() => m.chunk([1], 1.5), RangeError); }],
  ["parseCsv: basic", async () => eq((await csv()).parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]])],
  ["parseCsv: quoted comma", async () => eq((await csv()).parseCsv('x,"a,b",y'), [["x", "a,b", "y"]])],
  ["parseCsv: doubled quotes", async () => eq((await csv()).parseCsv('"say ""hi""",z'), [['say "hi"', "z"]])],
  ["parseCsv: newline inside quotes", async () => eq((await csv()).parseCsv('"l1\nl2",b\nc,d'), [["l1\nl2", "b"], ["c", "d"]])],
  ["parseCsv: CRLF and trailing newline", async () => eq((await csv()).parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]])],
  ["parseCsv: empty fields", async () => eq((await csv()).parseCsv("a,,c\n,,"), [["a", "", "c"], ["", "", ""]])],
  ["parseCsv: empty string", async () => eq((await csv()).parseCsv(""), [])],
  ["template: basic", async () => eq((await tpl()).template("Hi {{name}}!", { name: "Ann" }), "Hi Ann!")],
  ["template: spaces and dotted paths", async () => eq((await tpl()).template("{{ user.name }} is {{user.age}}", { user: { name: "Bo", age: 7 } }), "Bo is 7")],
  ["template: missing is empty", async () => eq((await tpl()).template("[{{nope}}][{{a.b.c}}]", { a: {} }), "[][]")],
  ["template: repeats, falsy values", async () => eq((await tpl()).template("{{n}}{{n}}{{f}}", { n: 0, f: false }), "00false")],
  ["template: no placeholders", async () => eq((await tpl()).template("plain {text}", {}), "plain {text}")],
  ["index re-exports all eight", async () => { const m = await load("src/index.js"); for (const f of NAMES) assert.equal(typeof m[f], "function", f); }],
  ["README documents all eight", async () => { const r = readFileSync(join(repo, "README.md"), "utf8"); for (const f of NAMES) assert.ok(r.includes(f), `README lacks ${f}`); }],
]);
