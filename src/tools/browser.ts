// Browser tools: a real Chrome tab per chat (T3: preview_open/act/snapshot); the person sees it live.

import type { ToolContext } from "./context.ts";
import type { HarnessTool } from "../types.ts";

/** A real browser (T3: preview_open/act/snapshot). The person sees the same page in the Browser panel. */
export function browserTools(ctx: ToolContext, threadId: string): HarnessTool[] {
  const b = ctx.browser;
  const wrap = (fn: (a: Record<string, string>) => Promise<string>) => async (a: Record<string, string>) => {
    try {
      return { text: await fn(a) };
    } catch (err) {
      return { isError: true, text: (err as Error).message.split("\n")[0] };
    }
  };
  return [
    {
      name: "browser_open",
      description:
        "Open a page in your browser (a real Chrome tab; the person sees it live in the Browser panel). Works for localhost dev servers and public sites. Then use browser_snapshot to read it.",
      params: { url: { description: "e.g. localhost:3000, http://localhost:5173/login, https://example.com" } },
      run: wrap(async ({ url }) => {
        const r = await b.open(threadId, url ?? "");
        return `Opened ${r.url} — "${r.title}". Use browser_snapshot to read it.`;
      }),
    },
    {
      name: "browser_snapshot",
      description: "Read the open page: its URL, title, and an accessibility tree of what's on it (headings, text, links, buttons, inputs).",
      params: {},
      run: wrap(() => b.snapshot(threadId)),
    },
    {
      name: "browser_click",
      description: "Click something on the open page.",
      params: { target: { description: "Visible text, 'button \"Save\"' / 'link \"Docs\"', or a CSS selector." } },
      run: wrap(({ target }) => b.click(threadId, target ?? "")),
    },
    {
      name: "browser_type",
      description: "Type into a field on the open page (replaces what's there).",
      params: {
        target: { description: "The field's label, placeholder, or a CSS selector." },
        text: { description: "What to type." },
        submit: { description: "'yes' to press Enter after typing.", optional: true },
      },
      run: wrap(({ target, text, submit }) => b.type(threadId, target ?? "", text ?? "", /^y/i.test(submit ?? ""))),
    },
    {
      name: "browser_press",
      description: "Press a key on the open page, e.g. Enter, Escape, Tab, ArrowDown, Meta+A.",
      params: { key: { description: "The key." } },
      run: wrap(({ key }) => b.press(threadId, key ?? "Enter")),
    },
    {
      name: "browser_screenshot",
      description: "Save a screenshot of the open page and return its file path; read that image file to see the page.",
      params: {},
      run: wrap(async () => `Saved ${await b.screenshot(threadId)}`),
    },
  ];
}
