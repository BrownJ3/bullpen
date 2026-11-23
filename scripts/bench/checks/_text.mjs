// Checks shared by the goals that include the four text helpers.
import { assert, throws } from "./_t.mjs";
const eq = assert.deepEqual;

export const slugifyTests = (get) => [
  ["slugify: basic", async () => eq((await get()).slugify("Hello World"), "hello-world")],
  ["slugify: accents and punctuation", async () => eq((await get()).slugify("  Crème brûlée! "), "creme-brulee")],
  ["slugify: runs collapse", async () => eq((await get()).slugify("a--b__c"), "a-b-c")],
  ["slugify: separator option", async () => eq((await get()).slugify("Hello big World", { separator: "_" }), "hello_big_world")],
  ["slugify: maxLength", async () => eq((await get()).slugify("hello world", { maxLength: 5 }), "hello")],
  ["slugify: maxLength trims separator", async () => eq((await get()).slugify("hello world", { maxLength: 6 }), "hello")],
  ["slugify: empty", async () => eq((await get()).slugify(""), "")],
  ["slugify: non-string throws TypeError", async () => { const m = await get(); throws(() => m.slugify(42), TypeError); }],
];
export const wrapTests = (get) => [
  ["wordWrap: basic", async () => eq((await get()).wordWrap("the quick brown fox", 10), ["the quick", "brown fox"])],
  ["wordWrap: exact fit", async () => eq((await get()).wordWrap("aaa bbb", 7), ["aaa bbb"])],
  ["wordWrap: long word alone", async () => eq((await get()).wordWrap("a supercalifragilistic b", 5), ["a", "supercalifragilistic", "b"])],
  ["wordWrap: whitespace runs", async () => eq((await get()).wordWrap("  one \n two\t three ", 20), ["one two three"])],
  ["wordWrap: empty", async () => eq((await get()).wordWrap("   ", 10), [])],
  ["wordWrap: bad width throws RangeError", async () => { const m = await get(); throws(() => m.wordWrap("a", 0), RangeError); }],
];
export const durationTests = (get) => [
  ["parseDuration: compound", async () => eq((await get()).parseDuration("1h 30m"), 5_400_000)],
  ["parseDuration: seconds", async () => eq((await get()).parseDuration("90s"), 90_000)],
  ["parseDuration: days", async () => eq((await get()).parseDuration("2d"), 172_800_000)],
  ["parseDuration: ms", async () => eq((await get()).parseDuration("250ms"), 250)],
  ["parseDuration: decimals", async () => eq((await get()).parseDuration("1.5h"), 5_400_000)],
  ["parseDuration: no spaces, upper case", async () => eq((await get()).parseDuration("1H30M10S"), 5_410_000)],
  ["parseDuration: empty throws SyntaxError", async () => { const m = await get(); throws(() => m.parseDuration(""), SyntaxError); }],
  ["parseDuration: junk throws SyntaxError", async () => { const m = await get(); throws(() => m.parseDuration("5 parsecs"), SyntaxError); }],
  ["parseDuration: bare number throws SyntaxError", async () => { const m = await get(); throws(() => m.parseDuration("10"), SyntaxError); }],
];
export const bytesTests = (get) => [
  ["formatBytes: zero", async () => eq((await get()).formatBytes(0), "0 B")],
  ["formatBytes: bytes have no decimals", async () => eq((await get()).formatBytes(1023), "1023 B")],
  ["formatBytes: KB", async () => eq((await get()).formatBytes(1024), "1.0 KB")],
  ["formatBytes: 1.5 KB", async () => eq((await get()).formatBytes(1536), "1.5 KB")],
  ["formatBytes: MB", async () => eq((await get()).formatBytes(1_048_576), "1.0 MB")],
  ["formatBytes: decimals option", async () => eq((await get()).formatBytes(1536, { decimals: 2 }), "1.50 KB")],
  ["formatBytes: stays in TB", async () => eq((await get()).formatBytes(1024 ** 5), "1024.0 TB")],
  ["formatBytes: negative throws RangeError", async () => { const m = await get(); throws(() => m.formatBytes(-1), RangeError); }],
  ["formatBytes: NaN throws RangeError", async () => { const m = await get(); throws(() => m.formatBytes(NaN), RangeError); }],
];
