import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Logger, Role } from "@valethq/sdk";
import type { PersonaFile } from "./types";

const DEFAULT_CAP = 65536;
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

export function defaultPersonaFiles(): PersonaEntry[] {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return [
    { path: "AGENTS.md", role: "agents" },
    { path: "SOUL.md", role: "soul" },
    { path: "IDENTITY.md", role: "identity" },
    { path: "USER.md", role: "user" },
    { path: "MEMORY.md", role: "memory", minRole: "owner" },
    { path: `memory/${dayKey(yesterday)}.md`, role: "daily", minRole: "owner" },
    { path: `memory/${dayKey(today)}.md`, role: "daily", minRole: "owner" },
  ];
}

function personaSpec(settings: Record<string, unknown>): { files: PersonaEntry[]; cap: number } {
  const raw = settings.persona;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { files: defaultPersonaFiles(), cap: DEFAULT_CAP };
  }
  const p = raw as { files?: unknown; maxBytesPerFile?: unknown };
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
    : defaultPersonaFiles();
  const cap =
    typeof p.maxBytesPerFile === "number" && p.maxBytesPerFile > 0 ? p.maxBytesPerFile : DEFAULT_CAP;
  return { files, cap };
}

export async function loadPersonaFiles(
  workspaceDir: string,
  settings: Record<string, unknown>,
  role: Role,
  log: Logger,
): Promise<PersonaFile[]> {
  const { files, cap } = personaSpec(settings);
  const decoder = new TextDecoder();
  const out: PersonaFile[] = [];
  for (const f of files) {
    if (ROLE_RANK[role] < ROLE_RANK[f.minRole ?? "guest"]) continue;
    let bytes: Uint8Array;
    try {
      bytes = await readFile(resolve(workspaceDir, f.path));
    } catch {
      continue; // missing files are skipped silently
    }
    let content = decoder.decode(bytes.subarray(0, cap));
    if (bytes.length > cap) {
      content += `\n\n[valet: truncated ${bytes.length - cap} bytes over the per-file cap]`;
      log.warn("persona file exceeds per-file cap", { path: f.path, bytes: bytes.length, cap });
    }
    out.push({ path: f.path, role: f.role ?? "other", content });
  }
  return out;
}
