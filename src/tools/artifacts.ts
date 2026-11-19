// Artifact tools: agents publish pages and reports to the person's Artifacts list, and read the ones there.

import { existsSync, readFileSync, statSync } from "node:fs";
import type { ToolContext } from "./context.ts";
import { postNote } from "../notes.ts";
import type { HarnessTool } from "../types.ts";

/** Artifacts: agents publish pages and reports to the person's Artifacts list (and read the ones there). */
export function artifactTools(ctx: ToolContext, threadId: string): HarnessTool[] {
  const posted = (a: { id: string; title: string; version: number }, verb: string) =>
    postNote(ctx.store, threadId, `${verb} the artifact **${a.title}**${a.version > 1 ? ` (version ${a.version})` : ""}.`, { action: { kind: "open_artifact", artifactId: a.id } });
  const line = (a: { id: string; title: string; source: string; kind: string; version: number; updatedAt: string }) =>
    `${a.id.slice(0, 8)}  ${a.source === "claude" ? "claude.ai" : "bullpen"}  ${a.kind}${a.version ? ` v${a.version}` : ""}  "${a.title}"  ${a.updatedAt.slice(0, 10)}`;
  return [
    {
      name: "create_artifact",
      description:
        "Publish a page for the person: an HTML page (report, dashboard, diagram, prototype, slides) or a Markdown document. It appears in their Artifacts list and opens beside the chat. " +
        "Make HTML self-contained (inline CSS/JS; libraries only from a CDN). Use this for anything they'll look at rather than files for the project.",
      params: {
        title: { description: "Short name, e.g. 'Q3 latency report'." },
        content: { description: "The full HTML page or Markdown text. Or leave empty and pass file.", optional: true },
        file: { description: "Absolute path of an .html or .md file you wrote, instead of content.", optional: true },
        description: { description: "One sentence on what it is.", optional: true },
      },
      run: async (a) => {
        try {
          const content = a.content?.trim() ? a.content : a.file ? readText(a.file) : "";
          if (!content.trim()) return { isError: true, text: "Pass content or file." };
          const t = ctx.requireThread(threadId);
          const art = ctx.artifacts.create({
            title: a.title ?? "",
            content,
            kind: a.file?.endsWith(".md") ? "markdown" : undefined,
            description: a.description,
            threadId,
            agentId: t.agentId,
            project: ctx.projectOf(threadId),
          });
          posted(art, "Made");
          return { text: `Published as artifact ${art.id.slice(0, 8)} ("${art.title}"). Update it with update_artifact; tell the person it's in Artifacts.` };
        } catch (err) {
          return { isError: true, text: (err as Error).message };
        }
      },
    },
    {
      name: "update_artifact",
      description: "Replace an artifact's content with a new version (the old ones are kept).",
      params: {
        artifact: { description: "Its id (or first 8 characters)." },
        content: { description: "The full new content. Or pass file.", optional: true },
        file: { description: "Absolute path of the new .html or .md file.", optional: true },
        title: { description: "New title, if it changes.", optional: true },
      },
      run: async (a) => {
        try {
          const content = a.content?.trim() ? a.content : a.file ? readText(a.file) : "";
          if (!content.trim()) return { isError: true, text: "Pass content or file." };
          const art = ctx.artifacts.update(a.artifact ?? "", content, a.title);
          posted(art, "Updated");
          return { text: `Artifact ${art.id.slice(0, 8)} is now version ${art.version}.` };
        } catch (err) {
          return { isError: true, text: (err as Error).message };
        }
      },
    },
    {
      name: "list_artifacts",
      description: "List the person's artifacts: ones made in Bullpen and ones from their claude.ai account.",
      params: { search: { description: "Only titles containing this.", optional: true } },
      run: async ({ search }) => {
        const q = (search ?? "").toLowerCase();
        const list = ctx.store.listArtifacts().filter((x) => !q || x.title.toLowerCase().includes(q)).slice(0, 40);
        return { text: list.map(line).join("\n") || "(no artifacts)" };
      },
    },
    {
      name: "read_artifact",
      description: "Read an artifact's content (HTML or Markdown). claude.ai artifacts must be copied into Bullpen first (the person can do that from Artifacts).",
      params: { artifact: { description: "Its id (or first 8 characters)." } },
      run: async ({ artifact }) => {
        try {
          const { artifact: x, content, version } = ctx.artifacts.content(artifact ?? "");
          const clipped = content.length > 60_000 ? `${content.slice(0, 60_000)}\n…[truncated]` : content;
          return { text: `${line(x)} (showing version ${version})\n\n${clipped}` };
        } catch (err) {
          const x = ctx.store.listArtifacts().find((y) => y.id.startsWith(artifact ?? "-"));
          return { isError: true, text: x?.url ? `${(err as Error).message} It's on claude.ai at ${x.url}.` : (err as Error).message };
        }
      },
    },
  ];
}

/** A text file an agent points at (for create_artifact), within reason. */
function readText(path: string): string {
  if (!existsSync(path)) throw new Error(`No file ${path}.`);
  if (statSync(path).size > 8 * 1024 * 1024) throw new Error("That file is over 8 MB.");
  return readFileSync(path, "utf8");
}
