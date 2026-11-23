# notes

A small JSON API for notes: `node server.js`. Use only Node.js built-ins (no npm packages).

It listens on the port in the `PORT` environment variable (default 3000). Notes are kept in memory. Every response
with a body is JSON with `Content-Type: application/json`. Errors are `{ "error": "<message>" }`.

A note is `{ id, title, body, tags, createdAt, updatedAt }`:

- `id`: a whole number. The first note is 1 and each new note is one higher. Ids are never reused, and a request that
  fails doesn't use one up.
- `title`: a string of 1 to 100 characters. Required.
- `body`: a string. Optional when creating; defaults to `""`.
- `tags`: an array of strings. Optional when creating; defaults to `[]`.
- `createdAt`, `updatedAt`: ISO 8601 timestamps. They are equal when the note is created.

| Request | Response |
|---|---|
| `POST /notes` with `{ title, body?, tags? }` | `201` and the new note. `400` if a field is invalid or the JSON can't be parsed. |
| `GET /notes` | `200` and every note, in id order. |
| `GET /notes?tag=x` | Only notes with that tag. |
| `GET /notes?q=text` | Only notes whose title or body contains the text, ignoring case. |
| `GET /notes/:id` | `200` and the note, or `404`. |
| `PATCH /notes/:id` with any of `{ title, body, tags }` | `200` and the updated note, with a new `updatedAt`. `400` if a field is invalid; `404` if there's no such note. |
| `DELETE /notes/:id` | `204` with no body, or `404`. |
| `GET /stats` | `200` and `{ "count": 2, "tags": { "work": 1, "home": 2 } }`: how many notes there are, and how many notes have each tag. |

Any other path is `404`. A known path (`/notes`, `/notes/:id`, `/stats`) with a method it doesn't support is `405`.
