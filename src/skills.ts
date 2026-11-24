import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Logger, Role } from "@valethq/sdk";

const RANK: Record<Role, number> = { guest: 0, trusted: 1, owner: 2 };
const MAX_LISTED = 60;
const MAX_DESCRIPTION = 400;

export interface Skill {
  name: string;
  description: string;
  minRole: Role;
  /** Absolute skill directory. */
  dir: string;
  source: "project" | "global" | "custom";
}

export interface SkillRoot {
  dir: string;
  source: Skill["source"];
}

const unquote = (v: string): string => {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"'))
    return t.slice(1, -1).replace(/\\(["\\n])/g, (_, c: string) => (c === "n" ? "\n" : c));
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
};

/** Top-level `key: value` pairs of the leading `---` block, with block scalars and wrapped plain values. Nested maps are skipped. */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return { fields: {}, body: text };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i] ?? "");
    if (!m) continue;
    const key = m[1] as string;
    const value = (m[2] ?? "").trim();
    const cont: string[] = [];
    while (i + 1 < end && /^(\s+\S.*|\s*)$/.test(lines[i + 1] ?? "")) cont.push(lines[++i] as string);
    const block = /^([>|])[+-]?$/.exec(value);
    if (block) {
      const parts = cont.map((l) => l.trim());
      fields[key] = (block[1] === ">" ? parts.join(" ").replace(/ {2,}/g, " ") : parts.join("\n")).trim();
    } else if (value !== "") {
      fields[key] = unquote([value, ...cont.map((l) => l.trim()).filter(Boolean)].join(" "));
    }
  }
  return {
    fields,
    body: lines
      .slice(end + 1)
      .join("\n")
      .replace(/^\n+/, ""),
  };
}

const isRole = (v: unknown): v is Role => v === "guest" || v === "trusted" || v === "owner";

async function isDir(p: string): Promise<boolean> {
  return (await stat(p).catch(() => undefined))?.isDirectory() ?? false;
}

/** Skills under each root (`<root>/<dir>/SKILL.md`); the first root to claim a name wins. */
export async function discoverSkills(roots: SkillRoot[], log: Logger): Promise<Skill[]> {
  const found = new Map<string, Skill>();
  for (const root of roots) {
    const names = (await readdir(root.dir).catch(() => [])).sort();
    for (const entry of names) {
      const dir = join(root.dir, entry);
      if (!(await isDir(dir))) continue;
      const text = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => undefined);
      if (text === undefined) continue;
      const { fields } = parseFrontmatter(text);
      const name = fields.name?.trim() || entry;
      const description = (fields.description ?? "").replace(/\s+/g, " ").trim();
      if (!description) {
        log.warn("skill has no description and is skipped", { dir });
        continue;
      }
      if (found.has(name)) continue;
      const minRole = isRole(fields.minRole) ? fields.minRole : "owner";
      found.set(name, { name, description, minRole, dir, source: root.source });
    }
  }
  return [...found.values()];
}

/**
 * The project's `settings.skills`: `enabled: false` turns skills off, `paths` replaces the default roots
 * (relative paths resolve against the workspace). Defaults: `<workspace>/skills`, then `<valetHome>/skills`, then `~/.agents/skills`.
 */
export function skillRoots(
  workspaceDir: string,
  settings: Record<string, unknown>,
  valetHome: string,
  userHome: string,
): SkillRoot[] | null {
  const raw = settings.skills;
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (s.enabled === false) return null;
  if (Array.isArray(s.paths)) {
    return s.paths
      .filter((p): p is string => typeof p === "string" && p !== "")
      .map((p) => ({ dir: isAbsolute(p) ? p : resolve(workspaceDir, p), source: "custom" as const }));
  }
  return [
    { dir: resolve(workspaceDir, "skills"), source: "project" },
    { dir: join(valetHome, "skills"), source: "global" },
    { dir: join(userHome, ".agents", "skills"), source: "global" },
  ];
}

export const visibleTo = (skills: Skill[], role: Role): Skill[] =>
  skills.filter((s) => RANK[role] >= RANK[s.minRole]);

export const findSkill = (skills: Skill[], name: string): Skill | undefined => {
  const n = name.trim().toLowerCase();
  return (
    skills.find((s) => s.name.toLowerCase() === n) ??
    skills.find((s) => s.dir.split("/").at(-1)?.toLowerCase() === n)
  );
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3).trimEnd()}...` : s);

/** The preamble section: names and descriptions only, bodies load through skill_read. Empty when there are no skills. */
export function renderSkills(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const shown = skills.slice(0, MAX_LISTED);
  const lines = shown.map((s) => `- ${s.name}: ${clip(s.description, MAX_DESCRIPTION)}`);
  if (skills.length > shown.length) lines.push(`- (${skills.length - shown.length} more not listed)`);
  return [
    "## Skills",
    "When a task matches a skill below, call `skill_read` with its name to load its instructions before you start. Skills can bundle scripts and references; `skill_read` lists them and gives the skill's directory.",
    lines.join("\n"),
  ].join("\n\n");
}
