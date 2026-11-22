import { afterAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolCall } from "@valethq/sdk";
import { loadPersonaFiles } from "../src/persona";
import { viewImageTool } from "../src/image";
import { skillReadTool } from "../src/skillTool";
import type { Skill } from "../src/skills";
import { aclCtx, caller, cleanup, workspace } from "./helpers";

afterAll(cleanup);

const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

const log = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };

describe("light fixes", () => {
  test("C1: view_image sniffs magic bytes and rejects extension-only fakes", async () => {
    const dir = await workspace({});
    await writeFile(join(dir, "fake.png"), "not an image");
    await writeFile(join(dir, "real.png"), PNG);
    const puts: unknown[] = [];
    const ctx = aclCtx({
      blobs: {
        put: async (_b: Uint8Array, m: unknown) => {
          puts.push(m);
          return { id: "b1" };
        },
      },
    });
    const tool = viewImageTool(ctx);
    const call = { cwd: dir, role: "owner", caller: caller() } as ToolCall;
    expect((await tool.invoke({ path: "fake.png" }, call)).isError).toBe(true);
    expect(puts).toHaveLength(0);
    const ok = await tool.invoke({ path: "real.png" }, call);
    expect(ok.isError).toBeUndefined();
    expect(puts).toHaveLength(1);
  });

  test("C2: persona cap read stops on a UTF-8 boundary and reports full file size", async () => {
    const dir = await workspace({});
    const multi = "€"; // 3 bytes in UTF-8
    const body = `${"a".repeat(8)}${multi}`;
    await writeFile(join(dir, "u.md"), body, "utf8");
    const intact = await loadPersonaFiles(
      dir,
      { persona: { files: [{ path: "u.md" }], maxBytesPerFile: 11 } },
      "owner",
      log,
    );
    expect(intact[0]?.content).toBe(body);
    expect(intact[0]?.content).not.toContain("\uFFFD");
    const trimmed = await loadPersonaFiles(
      dir,
      { persona: { files: [{ path: "u.md" }], maxBytesPerFile: 10 } },
      "owner",
      log,
    );
    expect(trimmed[0]?.content.startsWith("a".repeat(8))).toBe(true);
    expect(trimmed[0]?.content).not.toContain("\uFFFD");
    expect(trimmed[0]?.content).toContain("[valet: truncated 1 bytes");
  });

  test("C3: skill_read caps bundled text without splitting UTF-8", async () => {
    const dir = await workspace({
      "skill/SKILL.md": "---\nname: s\n---\n",
      [`skill/note.md`]: `${"b".repeat(65535)}ž`,
    });
    const skillDir = join(dir, "skill");
    const skills = async (): Promise<Skill[]> => [
      { name: "s", dir: skillDir, description: "d", minRole: "guest", source: "project" },
    ];
    const tool = skillReadTool(aclCtx(), skills);
    const call = { cwd: dir, role: "owner", caller: caller() } as ToolCall;
    const res = await tool.invoke({ name: "s", file: "note.md" }, call);
    expect(res.isError).toBeUndefined();
    const out = res.content.map((c) => ("text" in c ? c.text : "")).join("");
    expect(out).not.toContain("\uFFFD");
    expect(out).toContain("[truncated ");
  });
});
