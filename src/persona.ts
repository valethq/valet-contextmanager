import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Logger, PersonaFile, Role } from "@valethq/sdk";
import { matchPatterns } from "./patterns";

export const DEFAULT_CAP = 65536;
const DAILY_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
const ROLE_RANK: Record<Role, number> = { guest: 0, trusted: 1, owner: 2 };
const FILE_ROLES = new Set<PersonaFile["role"]>([
  "agents",
  "user",
  "memory",
  "soul",
  "identity",
  "daily",
  "other",
]);
const ROLES = new Set<Role>(["guest", "trusted", "owner"]);

interface PersonaEntry {
  path: string;
  role?: PersonaFile["role"];
  minRole?: Role;
}

function dayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export async function defaultPersonaFiles(workspaceDir: string): Promise<PersonaEntry[]> {
  const files: PersonaEntry[] = [
    { path: "AGENTS.md", role: "agents" },
    { path: "SOUL.md", role: "soul" },
    { path: "IDENTITY.md", role: "identity" },
    { path: "USER.md", role: "user" },
    { path: "MEMORY.md", role: "memory", minRole: "owner" },
  ];
  let names: string[] = [];
  try {
    names = (await readdir(resolve(workspaceDir, "memory"), { withFileTypes: true }))
      .filter((e) => e.isFile() && DAILY_RE.test(e.name))
      .map((e) => e.name);
  } catch {
    // no memory dir means no daily files
  }
  const today = dayKey(new Date());
  for (const name of names
    .filter((n) => n.slice(0, 10) <= today)
    .sort()
    .slice(-2)) {
    files.push({ path: `memory/${name}`, role: "daily", minRole: "owner" });
  }
  return files;
}

function personaSpec(
  settings: Record<string, unknown>,
  defaultCap: number,
): { files: PersonaEntry[] | null; patterns: string[] | null; cap: number } {
  const raw = settings.persona;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { files: null, patterns: null, cap: defaultCap };
  }
  const p = raw as { files?: unknown; patterns?: unknown; maxBytesPerFile?: unknown };
  const patterns = Array.isArray(p.patterns)
    ? p.patterns.filter((x): x is string => typeof x === "string")
    : null;
  const files = Array.isArray(p.files)
    ? p.files.flatMap((e): PersonaEntry[] => {
        if (!e || typeof e !== "object") return [];
        const o = e as { path?: unknown; role?: unknown; minRole?: unknown };
        if (typeof o.path !== "string" || o.path.length === 0) return [];
        return [
          {
            path: o.path,
            role: FILE_ROLES.has(o.role as PersonaFile["role"]) ? (o.role as PersonaFile["role"]) : undefined,
            minRole: ROLES.has(o.minRole as Role) ? (o.minRole as Role) : undefined,
          },
        ];
      })
    : null;
  const cap = typeof p.maxBytesPerFile === "number" && p.maxBytesPerFile > 0 ? p.maxBytesPerFile : defaultCap;
  return { files, patterns, cap };
}

/** Explicit `files` and `patterns` replace the defaults; pattern matches follow the listed files, deduplicated. */
async function personaEntries(
  workspaceDir: string,
  spec: { files: PersonaEntry[] | null; patterns: string[] | null },
  log: Logger,
): Promise<PersonaEntry[]> {
  if (spec.files === null && spec.patterns === null) return defaultPersonaFiles(workspaceDir);
  const listed = spec.files ?? [];
  if (spec.patterns === null) return listed;
  const taken = new Set(listed.map((f) => f.path));
  const matched = (await matchPatterns(workspaceDir, spec.patterns, log))
    .filter((path) => !taken.has(path))
    .map((path): PersonaEntry => ({ path }));
  return [...listed, ...matched];
}

export async function loadPersonaFiles(
  workspaceDir: string,
  settings: Record<string, unknown>,
  role: Role,
  log: Logger,
  defaultCap = DEFAULT_CAP,
): Promise<PersonaFile[]> {
  const spec = personaSpec(settings, defaultCap);
  const files = await personaEntries(workspaceDir, spec, log);
  const { cap } = spec;
  const out: PersonaFile[] = [];
  for (const f of files) {
    if (ROLE_RANK[role] < ROLE_RANK[f.minRole ?? "guest"]) continue;
    const path = resolve(workspaceDir, f.path);
    let fileSize: number;
    let chunk: Uint8Array;
    try {
      fileSize = (await stat(path)).size;
      chunk = new Uint8Array(
        await Bun.file(path)
          .slice(0, cap + 1)
          .arrayBuffer(),
      );
    } catch {
      continue; // missing files are skipped silently
    }
    const dec = new TextDecoder("utf-8", { fatal: true });
    let end = Math.min(chunk.length, cap);
    let content = "";
    while (end > 0) {
      try {
        content = dec.decode(chunk.subarray(0, end));
        break;
      } catch {
        end--;
      }
    }
    if (fileSize > cap) {
      content += `\n\n[valet: truncated ${fileSize - cap} bytes over the per-file cap]`;
      log.warn("persona file exceeds per-file cap", { path: f.path, bytes: fileSize, cap });
    }
    out.push({ path: f.path, role: f.role ?? "other", content });
  }
  return out;
}
