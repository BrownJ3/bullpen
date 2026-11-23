import { assert, load, run } from "./_t.mjs";
import { bytesTests, durationTests, slugifyTests, wrapTests } from "./_text.mjs";
run([
  ...slugifyTests(() => load("src/slugify.js")),
  ...wrapTests(() => load("src/wrap.js")),
  ...durationTests(() => load("src/duration.js")),
  ...bytesTests(() => load("src/bytes.js")),
  ["index re-exports all four", async () => {
    const m = await load("src/index.js");
    for (const f of ["slugify", "wordWrap", "parseDuration", "formatBytes"]) assert.equal(typeof m[f], "function", f);
  }],
]);
