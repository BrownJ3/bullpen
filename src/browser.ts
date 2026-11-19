// A real browser per thread (T3: server-side browser preview with preview_open/act/snapshot).
// Headless Chrome through Playwright: agents drive it with harness tools, and the Browser panel shows the same page
// live (screenshots) and forwards your clicks and typing, so any site loads, not just ones that allow framing.
// Each thread gets its own fresh browser context: no cookies, logins or history from your own Chrome.

import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { HOME } from "./home.ts";

const VIEWPORT = { width: 1280, height: 800 };
const IDLE_CLOSE_MS = 15 * 60_000;
const SNAPSHOT_CHARS = 14_000;

interface Tab {
  context: BrowserContext;
  page: Page;
  lastUsed: number;
  shots: number;
}

export class BrowserHub {
  #browser: Promise<Browser> | undefined;
  readonly #tabs = new Map<string, Tab>();
  readonly #opening = new Map<string, Promise<Tab>>();
  #sweep: NodeJS.Timeout | undefined;

  async #launch(): Promise<Browser> {
    const { chromium } = await import("playwright-core");
    try {
      // Muted: it's hidden, so sound from a page (a game an agent is testing) would just play out of nowhere.
      return await chromium.launch({ channel: "chrome", headless: true, args: ["--mute-audio"] });
    } catch {
      // No Google Chrome: try Microsoft Edge, then Playwright's own Chromium if it was downloaded.
      try {
        return await chromium.launch({ channel: "msedge", headless: true, args: ["--mute-audio"] });
      } catch {
        return await chromium.launch({ headless: true, args: ["--mute-audio"] });
      }
    }
  }

  async #tab(threadId: string): Promise<Tab> {
    const existing = this.#tabs.get(threadId);
    if (existing && !existing.page.isClosed()) {
      existing.lastUsed = Date.now();
      return existing;
    }
    const pending = this.#opening.get(threadId);
    if (pending) return pending;
    const opening = (async () => {
      this.#browser ??= this.#launch();
      let browser: Browser;
      try {
        browser = await this.#browser;
        if (!browser.isConnected()) throw new Error("disconnected");
      } catch {
        this.#browser = this.#launch();
        browser = await this.#browser;
      }
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      const page = await context.newPage();
      // Popups open in the same tab, so the panel and the agent keep looking at one page.
      context.on("page", (p) => {
        if (p === page) return;
        void p.waitForLoadState("domcontentloaded").then(() => page.goto(p.url())).catch(() => {}).finally(() => p.close().catch(() => {}));
      });
      const tab: Tab = { context, page, lastUsed: Date.now(), shots: 0 };
      this.#tabs.set(threadId, tab);
      this.#sweep ??= setInterval(() => this.#closeIdle(), 60_000);
      return tab;
    })();
    this.#opening.set(threadId, opening);
    try {
      return await opening;
    } finally {
      this.#opening.delete(threadId);
    }
  }

  has(threadId: string): boolean {
    const t = this.#tabs.get(threadId);
    return Boolean(t && !t.page.isClosed());
  }

  async open(threadId: string, url: string): Promise<{ url: string; title: string }> {
    const target = normalizeUrl(url);
    const tab = await this.#tab(threadId);
    await tab.page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await tab.page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
    return { url: tab.page.url(), title: await tab.page.title() };
  }

  /** What's on the page, as an accessibility tree (roles, names, text): what an agent reads to decide what to do. */
  async snapshot(threadId: string): Promise<string> {
    const tab = await this.#tab(threadId);
    const page = tab.page;
    if (page.url() === "about:blank") return "No page open. Use browser_open first.";
    let tree = "";
    try {
      tree = await page.locator("body").ariaSnapshot({ timeout: 5000 });
    } catch {
      tree = (await page.locator("body").innerText({ timeout: 5000 }).catch(() => "")).slice(0, SNAPSHOT_CHARS);
    }
    if (tree.length > SNAPSHOT_CHARS) tree = `${tree.slice(0, SNAPSHOT_CHARS)}\n…[page truncated]`;
    return `URL: ${page.url()}\nTitle: ${await page.title()}\n\n${tree}`;
  }

  async click(threadId: string, target: string): Promise<string> {
    const tab = await this.#tab(threadId);
    const loc = await this.#find(tab.page, target);
    await loc.click({ timeout: 8000 });
    await tab.page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
    return `Clicked ${target}. Now at ${tab.page.url()}`;
  }

  async type(threadId: string, target: string, text: string, submit: boolean): Promise<string> {
    const tab = await this.#tab(threadId);
    const loc = await this.#find(tab.page, target, true);
    await loc.fill(text, { timeout: 8000 });
    if (submit) {
      await loc.press("Enter");
      await tab.page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
    }
    return `Typed into ${target}${submit ? " and pressed Enter" : ""}. Now at ${tab.page.url()}`;
  }

  async press(threadId: string, key: string): Promise<string> {
    const tab = await this.#tab(threadId);
    await tab.page.keyboard.press(key);
    return `Pressed ${key}.`;
  }

  async screenshot(threadId: string): Promise<string> {
    const tab = await this.#tab(threadId);
    const dir = join(HOME, "browser", threadId);
    mkdirSync(dir, { recursive: true });
    // Keep the last few only.
    const old = readdirSync(dir).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 9))) rmSync(join(dir, f), { force: true });
    const file = join(dir, `shot-${String(++tab.shots).padStart(4, "0")}.png`);
    await tab.page.screenshot({ path: file });
    return file;
  }

  /** A frame for the Browser panel. */
  async frame(threadId: string): Promise<{ image: string; url: string; title: string; width: number; height: number } | undefined> {
    if (!this.has(threadId)) return undefined;
    const tab = await this.#tab(threadId);
    const buf = await tab.page.screenshot({ type: "jpeg", quality: 70, timeout: 5000 });
    return { image: buf.toString("base64"), url: tab.page.url(), title: await tab.page.title().catch(() => ""), ...VIEWPORT };
  }

  /** Your clicks, scrolling and typing from the Browser panel. */
  async input(
    threadId: string,
    ev: { kind: "click"; x: number; y: number } | { kind: "wheel"; x: number; y: number; dy: number } | { kind: "key"; key: string } | { kind: "text"; text: string } | { kind: "nav"; to: "back" | "forward" | "reload" },
  ): Promise<void> {
    const tab = await this.#tab(threadId);
    const page = tab.page;
    switch (ev.kind) {
      case "click":
        await page.mouse.click(ev.x, ev.y);
        return;
      case "wheel":
        await page.mouse.move(ev.x, ev.y);
        await page.mouse.wheel(0, ev.dy);
        return;
      case "key":
        await page.keyboard.press(ev.key);
        return;
      case "text":
        await page.keyboard.insertText(ev.text);
        return;
      case "nav":
        if (ev.to === "back") await page.goBack({ timeout: 10_000 }).catch(() => {});
        else if (ev.to === "forward") await page.goForward({ timeout: 10_000 }).catch(() => {});
        else await page.reload({ timeout: 15_000 }).catch(() => {});
        return;
    }
  }

  async #find(page: Page, target: string, editable = false) {
    const t = target.trim();
    if (/^(css=|xpath=|\/\/|[#.[]|[a-z]+[#.[])/i.test(t)) return page.locator(t.replace(/^css=/, "")).first();
    const role = /^(button|link|textbox|checkbox|radio|combobox|tab|menuitem|option|heading|searchbox)\s+"(.+)"$/i.exec(t);
    if (role) return page.getByRole(role[1].toLowerCase() as "button", { name: role[2] }).first();
    const candidates = editable
      ? [page.getByLabel(t), page.getByPlaceholder(t), page.getByRole("textbox", { name: t }), page.getByRole("searchbox", { name: t })]
      : [page.getByRole("button", { name: t }), page.getByRole("link", { name: t }), page.getByLabel(t), page.getByText(t)];
    for (const c of candidates) if ((await c.count().catch(() => 0)) > 0) return c.first();
    throw new Error(`Nothing on the page matches "${t}". Use browser_snapshot to see what's there; target by visible text, 'button "Name"', or a CSS selector.`);
  }

  async close(threadId: string) {
    const tab = this.#tabs.get(threadId);
    this.#tabs.delete(threadId);
    await tab?.context.close().catch(() => {});
  }

  #closeIdle() {
    const cutoff = Date.now() - IDLE_CLOSE_MS;
    for (const [id, tab] of this.#tabs) if (tab.lastUsed < cutoff) void this.close(id);
    if (!this.#tabs.size && this.#browser) {
      const b = this.#browser;
      this.#browser = undefined;
      void b.then((x) => x.close()).catch(() => {});
      clearInterval(this.#sweep);
      this.#sweep = undefined;
    }
  }

  async shutdown() {
    clearInterval(this.#sweep);
    for (const id of [...this.#tabs.keys()]) await this.close(id);
    if (this.#browser) await (await this.#browser.catch(() => undefined))?.close().catch(() => {});
  }
}

/** "localhost:3000" → http://localhost:3000; "example.com" → https://example.com. Only web pages. */
export function normalizeUrl(input: string): string {
  let u = input.trim();
  if (/^\d+$/.test(u)) u = `localhost:${u}`;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(u) ? `http://${u}` : `https://${u}`;
  const parsed = new URL(u);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only http and https pages can be opened.");
  return parsed.toString();
}
