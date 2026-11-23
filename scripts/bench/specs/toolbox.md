# toolbox

A utility library of eight functions. Use only Node.js built-ins (no npm packages). The project is set up for ES modules (`import` / `export`); every function is a named export.

Also write:

- `src/index.js`, which re-exports all eight.
- `README.md`, with a short section for each function: its name, what it does and one example.

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

### `deepMerge(a, b)` in `src/merge.js`

Returns a new object: `a` with `b` merged over it. Neither argument is changed, and the result shares no nested
objects with them.

- Where both sides have a plain object, merge them the same way, to any depth.
- Otherwise the value from `b` wins, including `null`. Arrays are replaced, not joined.
- A key whose value in `b` is `undefined` is skipped.

Example: `deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3 } })` → `{ a: { x: 1, y: 3 } }`.

### `chunk(array, size)` in `src/chunk.js`

Splits an array into arrays of `size` items; the last may be shorter. An empty array gives `[]`. A `size` that isn't a
whole number of 1 or more throws a `RangeError`.

Example: `chunk([1, 2, 3, 4, 5], 2)` → `[[1, 2], [3, 4], [5]]`.

### `parseCsv(text)` in `src/csv.js`

Parses CSV text into an array of rows, each an array of strings.

- Fields are separated by commas; rows by `\n` or `\r\n`.
- A field in double quotes may contain commas, line breaks and quotes (written as two: `""`).
- Empty fields are empty strings. A line break at the very end doesn't add a row. `parseCsv("")` is `[]`.

Example: `parseCsv('x,"a,b",y')` → `[["x", "a,b", "y"]]`.

### `template(text, data)` in `src/template.js`

Replaces each `{{ name }}` in the text with a value from `data`.

- Spaces inside the braces are optional. Names may be dotted paths: `{{ user.name }}`.
- Values are converted with `String()`, so `0` and `false` appear as `0` and `false`.
- A name that isn't in `data` (or whose path breaks part-way) becomes an empty string.

Example: `template("Hi {{ user.name }}!", { user: { name: "Ann" } })` → `"Hi Ann!"`.
