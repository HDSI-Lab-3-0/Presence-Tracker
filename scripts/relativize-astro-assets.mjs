/**
 * GitHub Pages: root-absolute /_astro/ or /repo/_astro/ breaks when the live URL
 * doesn't match ASTRO_BASE. Same-dir-relative URLs work everywhere.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const distRoot = path.join(process.cwd(), "dist");

function depthOfHtmlFile(file) {
  const dir = path.dirname(file);
  const rel = path.relative(distRoot, dir);
  if (!rel || rel === ".") return 0;
  return rel.split(path.sep).length;
}

/** href="/_astro/..." or href="/a/b/_astro/..." (any depth) */
const ABS_ASTRO = /(href|src)="\/(?:[^"]+\/)*_astro\//g;

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full);
    } else if (e.name.endsWith(".html")) {
      await relativizeHtml(full);
    }
  }
}

async function relativizeHtml(file) {
  let html = await readFile(file, "utf8");
  const depth = depthOfHtmlFile(file);
  const prefix = depth === 0 ? "./" : `${"../".repeat(depth)}`;
  const next = html.replace(ABS_ASTRO, `$1="${prefix}_astro/`);
  if (next !== html) {
    await writeFile(file, next, "utf8");
    console.log(`[relativize] ${path.relative(distRoot, file)} → ${prefix}_astro/*`);
  }
}

await walk(distRoot);
