import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Logger } from "@valethq/sdk";

const SKIP_DIRS = new Set([".git", "node_modules"]);

async function listFiles(root: string, dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await listFiles(root, full, out);
    } else if (e.isFile()) {
      out.push(relative(root, full).split(sep).join("/"));
    }
  }
}

/**
 * Files under `root` (relative, forward-slash paths) matched by each regex, in pattern order and
 * alphabetical within a pattern. A file matched by several patterns is listed once. Invalid regexes are skipped.
 */
export async function matchPatterns(root: string, patterns: string[], log: Logger): Promise<string[]> {
  const compiled = patterns.flatMap((source) => {
    try {
      return [new RegExp(source)];
    } catch (error) {
      log.warn("persona pattern is not a valid regex", {
        pattern: source,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  });
  if (compiled.length === 0) return [];
  const all: string[] = [];
  await listFiles(root, root, all);
  all.sort();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const re of compiled)
    for (const path of all)
      if (!seen.has(path) && re.test(path)) {
        seen.add(path);
        out.push(path);
      }
  return out;
}
