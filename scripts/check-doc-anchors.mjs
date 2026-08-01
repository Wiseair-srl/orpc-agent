#!/usr/bin/env node
/**
 * Every internal `#anchor` in the docs must match an id VitePress actually
 * emits. `vitepress build` validates link *targets* but not their fragments,
 * so a heading rename silently breaks every deep link into it.
 *
 * Compares against the rendered HTML rather than reimplementing the slugifier,
 * which means it cannot drift from what ships. Run after `pnpm docs:build`.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const docs = join(root, "docs");
const dist = join(docs, ".vitepress/dist");

if (!existsSync(dist)) {
  console.error("No rendered site at docs/.vitepress/dist — run `pnpm docs:build` first.");
  process.exit(2);
}

function* walk(dir, extension) {
  for (const entry of readdirSync(dir)) {
    if (entry === ".vitepress" || entry === "public" || entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path, extension);
    else if (entry.endsWith(extension)) yield path;
  }
}

const idsByPage = new Map();
for (const html of walk(dist, ".html")) {
  const page = relative(dist, html).replace(/\.html$/, "");
  const ids = new Set([...readFileSync(html, "utf8").matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  idsByPage.set(page, ids);
}

const failures = [];
for (const markdown of walk(docs, ".md")) {
  const source = relative(docs, markdown);
  for (const [, target, anchor] of readFileSync(markdown, "utf8").matchAll(
    /\]\(([^)\s]*?)#([^)\s]+)\)/g,
  )) {
    if (/^https?:/.test(target)) continue;

    let page;
    if (target === "") page = source.replace(/\.md$/, "");
    else if (target.startsWith("/")) page = target.slice(1).replace(/\.md$/, "");
    else page = relative(docs, resolve(dirname(markdown), target)).replace(/\.md$/, "");
    page = page.replace(/(^|\/)index$/, "$1").replace(/\/$/, "") || "index";

    // Links to repository-root files are rewritten to /appendix/* at render
    // time by the markdown plugin; their fragments live in the included file.
    if (page.startsWith("..")) continue;

    const ids = idsByPage.get(page);
    if (!ids) {
      failures.push(`${source}: → ${target}#${anchor} — no rendered page at "${page}"`);
      continue;
    }
    if (!ids.has(anchor)) {
      const loose = (value) => value.replace(/[^a-z0-9]/gi, "").toLowerCase();
      const near = [...ids].find((id) => loose(id) === loose(anchor));
      failures.push(
        `${source}: #${anchor} does not exist on "${page}"` +
          (near ? ` — did you mean #${near} ?` : ""),
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`Doc anchor check failed (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("Doc anchors OK — every internal #fragment resolves to a rendered heading");
