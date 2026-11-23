# textkit

A small library of four text helpers. Use only Node.js built-ins (no npm packages). The project is set up for ES modules (`import` / `export`); every function is a named export.

Also write `src/index.js`, which re-exports all four.

### `slugify(text, options?)` in `src/slugify.js`

Turns text into a URL slug. `options` is `{ separator = "-", maxLength }`.

- Lower-case the text and remove accents (`"Crème"` → `"creme"`).
- Every run of characters other than `a-z` and `0-9` becomes one separator.
- No separator at the start or end.
- With `maxLength`, cut the result to at most that many characters, then remove a separator left at the end.
- `slugify("")` is `""`. If `text` isn't a string, throw a `TypeError`.

Examples: `slugify("Hello World")` → `"hello-world"`; `slugify("a--b__c")` → `"a-b-c"`;
`slugify("hello world", { maxLength: 6 })` → `"hello"`.

### `wordWrap(text, width)` in `src/wrap.js`

Returns an array of lines, each at most `width` characters.

- Words are separated by any run of whitespace (spaces, tabs, newlines); lines are joined with single spaces.
- Fill each line with as many words as fit.
- A word longer than `width` goes on a line of its own, unbroken.
- Empty or all-whitespace text gives `[]`. A `width` below 1 throws a `RangeError`.

Example: `wordWrap("the quick brown fox", 10)` → `["the quick", "brown fox"]`.

### `parseDuration(text)` in `src/duration.js`

Parses a duration into milliseconds.

- One or more parts, each a number followed by a unit: `ms`, `s`, `m`, `h` or `d`. Units are case-insensitive.
- Whitespace between parts is optional: `"1h 30m"` and `"1h30m"` are both 5400000.
- Numbers may have decimals: `"1.5h"` is 5400000.
- Anything else (empty text, an unknown unit, a number with no unit) throws a `SyntaxError`.

Examples: `"90s"` → `90000`; `"2d"` → `172800000`; `"250ms"` → `250`.

### `formatBytes(bytes, options?)` in `src/bytes.js`

Formats a byte count for people. `options` is `{ decimals = 1 }`.

- Units are `B`, `KB`, `MB`, `GB`, `TB`, each 1024 times the last. Use the largest unit that gives a value of at least 1.
- Bytes are shown as a whole number: `"0 B"`, `"1023 B"`. Other units use `decimals` places: `"1.0 KB"`, `"1.5 KB"`.
- There is nothing above `TB`: 1024⁵ bytes is `"1024.0 TB"`.
- A negative or non-finite number throws a `RangeError`.

Examples: `formatBytes(1048576)` → `"1.0 MB"`; `formatBytes(1536, { decimals: 2 })` → `"1.50 KB"`.
