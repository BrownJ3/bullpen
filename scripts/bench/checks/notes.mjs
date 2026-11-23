import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { assert, repo, run } from "./_t.mjs";

const port = await new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const server = spawn(process.execPath, [join(repo, "server.js")], { cwd: repo, env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
process.on("exit", () => server.kill());
const base = `http://127.0.0.1:${port}`;
const req = async (method, path, body, raw) => {
  const res = await fetch(base + path, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, type: res.headers.get("content-type") ?? "" };
};
for (let i = 0; i < 40; i++) { try { await fetch(base + "/notes"); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
const eq = assert.deepEqual;
// These run in order against one server.
run([
  ["GET /notes starts empty", async () => { const r = await req("GET", "/notes"); eq(r.status, 200); eq(r.json, []); assert.match(r.type, /application\/json/); }],
  ["POST /notes creates", async () => {
    const r = await req("POST", "/notes", { title: "First", body: "Hello there", tags: ["a", "b"] });
    eq(r.status, 201); eq(r.json.id, 1); eq(r.json.title, "First"); eq(r.json.body, "Hello there"); eq(r.json.tags, ["a", "b"]);
    assert.ok(!Number.isNaN(Date.parse(r.json.createdAt))); eq(r.json.createdAt, r.json.updatedAt);
  }],
  ["POST defaults body and tags", async () => { const r = await req("POST", "/notes", { title: "Second" }); eq(r.status, 201); eq(r.json.id, 2); eq(r.json.body, ""); eq(r.json.tags, []); }],
  ["POST rejects a missing title", async () => { const r = await req("POST", "/notes", { body: "x" }); eq(r.status, 400); eq(typeof r.json.error, "string"); }],
  ["POST rejects an empty or long title", async () => { eq((await req("POST", "/notes", { title: "" })).status, 400); eq((await req("POST", "/notes", { title: "x".repeat(101) })).status, 400); }],
  ["POST rejects bad tags", async () => eq((await req("POST", "/notes", { title: "t", tags: ["ok", 5] })).status, 400)],
  ["POST rejects malformed JSON", async () => { const r = await req("POST", "/notes", null, "{nope"); eq(r.status, 400); eq(typeof r.json.error, "string"); }],
  ["failed creates use no ids", async () => { const r = await req("POST", "/notes", { title: "Third", body: "say HELLO", tags: ["b"] }); eq(r.json.id, 3); }],
  ["GET /notes lists in id order", async () => eq((await req("GET", "/notes")).json.map((n) => n.id), [1, 2, 3])],
  ["GET /notes?tag=", async () => { eq((await req("GET", "/notes?tag=b")).json.map((n) => n.id), [1, 3]); eq((await req("GET", "/notes?tag=zzz")).json, []); }],
  ["GET /notes?q= is case-insensitive over title and body", async () => { eq((await req("GET", "/notes?q=hello")).json.map((n) => n.id), [1, 3]); eq((await req("GET", "/notes?q=SECOND")).json.map((n) => n.id), [2]); }],
  ["GET /notes/:id", async () => { const r = await req("GET", "/notes/2"); eq(r.status, 200); eq(r.json.title, "Second"); }],
  ["GET /notes/:id unknown is 404", async () => { const r = await req("GET", "/notes/99"); eq(r.status, 404); eq(typeof r.json.error, "string"); }],
  ["PATCH updates part of a note", async () => {
    const r = await req("PATCH", "/notes/2", { body: "now with text" });
    eq(r.status, 200); eq(r.json.title, "Second"); eq(r.json.body, "now with text"); assert.ok(Date.parse(r.json.updatedAt) >= Date.parse(r.json.createdAt));
    eq((await req("GET", "/notes/2")).json.body, "now with text");
  }],
  ["PATCH validates and 404s", async () => { eq((await req("PATCH", "/notes/2", { title: "" })).status, 400); eq((await req("PATCH", "/notes/99", { title: "x" })).status, 404); }],
  ["GET /stats", async () => { const r = await req("GET", "/stats"); eq(r.status, 200); eq(r.json, { count: 3, tags: { a: 1, b: 2 } }); }],
  ["DELETE removes", async () => { const r = await req("DELETE", "/notes/1"); eq(r.status, 204); eq(r.text, ""); eq((await req("GET", "/notes/1")).status, 404); eq((await req("DELETE", "/notes/1")).status, 404); }],
  ["stats follow deletes; ids are not reused", async () => { eq((await req("GET", "/stats")).json, { count: 2, tags: { b: 1 } }); eq((await req("POST", "/notes", { title: "Fourth" })).json.id, 4); }],
  ["unknown route is 404 JSON", async () => { const r = await req("GET", "/nope"); eq(r.status, 404); eq(typeof r.json.error, "string"); }],
  ["wrong method on a known route is 405", async () => { eq((await req("PUT", "/notes")).status, 405); eq((await req("POST", "/stats", {})).status, 405); }],
]);
