# todo

A command-line todo list: `node todo.js <command>`. Use only Node.js built-ins (no npm packages).

Todos are kept in a JSON file: the path in the `TODO_FILE` environment variable, or `./todos.json`. The file is a JSON
array of `{ "id": number, "text": string, "done": boolean }`, in id order. A missing file means no todos.

Normal output goes to stdout and the command exits 0. Errors go to stderr as `Error: <message>` and the command exits 1.
Print exactly the text shown, with nothing extra.

| Command | What it does | Prints |
|---|---|---|
| `add <words…>` | Adds a todo; the words are joined with spaces. Its id is the highest id in the file plus 1 (1 if there are none). | `Added 1: buy milk` |
| `list` | Shows every todo in id order, one per line: `[ ]` not done, `[x]` done. | `[ ] 1: buy milk` |
| `list --pending` | Only todos that aren't done. | |
| `list --done` | Only todos that are done. | |
| `done <id>` | Marks a todo done. | `Done 1: buy milk` |
| `rm <id>` | Removes a todo. | `Removed 1: buy milk` |
| `clear-done` | Removes every done todo. | `Cleared 2` |

When `list` has nothing to show, it prints `No todos.`

Errors:

- `add` with no words: `Error: text required`
- `done` or `rm` with an id that doesn't exist: `Error: no todo 99`
- any other command: `Error: unknown command <command>`
