import { readFile, readdir, realpath, stat as fsStat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  type AclContext,
  defineTool,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from "@valethq/sdk";
import { type Skill, findSkill, parseFrontmatter } from "./skills";

const MAX_FILE_BYTES = 65536;
const MAX_LISTED_FILES = 60;
const SKIP = new Set([".git", "node_modules", "__pycache__"]);

const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

async function bundledFiles(dir: string, base = dir, depth = 0, out: string[] = []): Promise<string[]> {
  const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const e of entries) {
    if (out.length >= MAX_LISTED_FILES) break;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name) && depth < 3) await bundledFiles(full, base, depth + 1, out);
    } else if (relative(base, full) !== "SKILL.md") {
      out.push(relative(base, full).split(sep).join("/"));
    }
  }
  return out;
}

async function readInside(skill: Skill, file: string): Promise<ToolResult> {
  const root = await realpath(skill.dir);
  const target = await realpath(resolve(skill.dir, file)).catch(() => undefined);
  if (target === undefined) return fail(`No file "${file}" in skill ${skill.name}.`);
  if (target !== root && !target.startsWith(root + sep))
    return fail("That path is outside the skill directory.");
  const info = await fsStat(target);
  if (!info.isFile()) return fail(`"${file}" is not a file.`);
  const fileSize = info.size;
  const chunk = new Uint8Array(
    await Bun.file(target)
      .slice(0, MAX_FILE_BYTES + 1)
      .arrayBuffer(),
  );
  if (chunk.subarray(0, Math.min(chunk.length, 8000)).includes(0))
    return fail(`"${file}" is a binary file; use a shell tool on ${join(skill.dir, file)} instead.`);
  const dec = new TextDecoder("utf-8", { fatal: true });
  let end = Math.min(chunk.length, MAX_FILE_BYTES);
  let text = "";
  while (end > 0) {
    try {
      text = dec.decode(chunk.subarray(0, end));
      break;
    } catch {
      end--;
    }
  }
  return ok(
    fileSize > MAX_FILE_BYTES
      ? `${text}\n\n[truncated ${fileSize - MAX_FILE_BYTES} bytes over the ${MAX_FILE_BYTES} byte cap]`
      : text,
  );
}

interface Input {
  name: string;
  file?: string;
}

/** `skills` is re-evaluated on every call, so edits to SKILL.md apply without a restart. */
export function skillReadTool(
  ctx: AclContext,
  skills: (call: ToolCall) => Promise<Skill[]>,
): ToolDefinition<Input> {
  const def: ToolDefinition<Input> = {
    name: "skill_read",
    description:
      "Load a skill listed in your instructions. Returns the skill's SKILL.md and the files bundled with it. Pass `file` to read one of those files instead.",
    minRole: "guest",
    permission: "contextmanager:skill.read",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "The skill's name, as listed." },
        file: { type: "string", description: "A bundled file, relative to the skill directory." },
      },
    },
    async invoke(input, call) {
      if (typeof input?.name !== "string" || !input.name.trim())
        return fail("skill_read needs a skill name.");
      const all = await skills(call);
      const skill = findSkill(all, input.name);
      if (!skill) {
        const names = all.map((s) => s.name).join(", ");
        return fail(`No skill named "${input.name}".${names ? ` Available: ${names}.` : ""}`);
      }
      if (typeof input.file === "string" && input.file !== "") return readInside(skill, input.file);
      const text = await readFile(join(skill.dir, "SKILL.md"), "utf8").catch(() => undefined);
      if (text === undefined) return fail(`Skill ${skill.name} has no SKILL.md any more.`);
      const files = await bundledFiles(skill.dir);
      const listing =
        files.length > 0
          ? `\n\nBundled files (read with skill_read { name, file }):\n${files.map((f) => `- ${f}`).join("\n")}`
          : "";
      return ok(
        `# Skill: ${skill.name}\nDirectory: ${skill.dir}\nRelative paths in this skill resolve against that directory.\n\n${parseFrontmatter(text).body.trim()}${listing}`,
      );
    },
  };
  return defineTool(def, ctx);
}
