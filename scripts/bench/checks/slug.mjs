import { load, run } from "./_t.mjs";
import { slugifyTests } from "./_text.mjs";
run(slugifyTests(() => load("src/slugify.js")));
