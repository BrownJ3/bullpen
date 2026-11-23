# slug

Use only Node.js built-ins (no npm packages). The project is set up for ES modules (`import` / `export`); every function is a named export.

### `slugify(text, options?)` in `src/slugify.js`

Turns text into a URL slug. `options` is `{ separator = "-", maxLength }`.

- Lower-case the text and remove accents (`"Crème"` → `"creme"`).
- Every run of characters other than `a-z` and `0-9` becomes one separator.
- No separator at the start or end.
- With `maxLength`, cut the result to at most that many characters, then remove a separator left at the end.
- `slugify("")` is `""`. If `text` isn't a string, throw a `TypeError`.

Examples: `slugify("Hello World")` → `"hello-world"`; `slugify("a--b__c")` → `"a-b-c"`;
`slugify("hello world", { maxLength: 6 })` → `"hello"`.
