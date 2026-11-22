import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolCall, ToolDefinition } from "@valethq/sdk";
import { parseFrontmatter } from "../src/skills";
import { boot, caller, cleanup, model, project, session, workspace } from "./helpers";

afterAll(cleanup);

const skill = (name: string, description: string, extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nBody of ${name}.\n`;

async function setup(
  files: Record<string, string>,
  settings: Record<string, unknown> = {},
  home: Record<string, string> = {},
) {
  const dir = await workspace(files);
  const valetHome = await workspace(home);
  const b = boot({
    sessions: [session("s1", "p1")],
    projects: [project("p1", dir, settings)],
    valetHome,
  });
  return { b, dir, valetHome };
}

const call = (role: ToolCall["role"] = "owner"): ToolCall =>
  ({
    sessionId: "s1",
    runId: "r",
    callId: "c",
    role,
    caller: caller(),
    cwd: "/",
    signal: new AbortController().signal,
  }) as ToolCall;

const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text ?? "").join("");

async function skillRead(b: Awaited<ReturnType<typeof setup>>["b"], role: ToolCall["role"] = "owner") {
  const [tool] = (await b.skillTools("s1", role)) as ToolDefinition<{ name: string; file?: string }>[];
  return tool;
}

describe("frontmatter", () => {
  test("reads plain, quoted, folded and wrapped values and skips nested maps", () => {
    const { fields, body } = parseFrontmatter(
      [
        "---",
        'name: "quoted: name"',
        "description: >",
        "  First line",
        "  second line.",
        "metadata:",
        "  version: 3",
        'inline: {"a":1}',
        "minRole: trusted",
        "---",
        "",
        "# Title",
      ].join("\r\n"),
    );
    expect(fields).toMatchObject({
      name: "quoted: name",
      description: "First line second line.",
      minRole: "trusted",
    });
    expect(fields.version).toBeUndefined();
    expect(body).toBe("# Title");
  });

  test("a file without a frontmatter block keeps its text", () => {
    expect(parseFrontmatter("# just text")).toEqual({ fields: {}, body: "# just text" });
  });
});

describe("preamble", () => {
  test("lists skills from the project and from valet home; the project wins a name clash", async () => {
    const { b } = await setup(
      {
        "skills/alpha/SKILL.md": skill("alpha", "Project alpha."),
        "skills/beta/SKILL.md": skill("beta", "Does beta things."),
      },
      {},
      {
        "skills/alpha/SKILL.md": skill("alpha", "Global alpha, shadowed."),
        "skills/gamma/SKILL.md": skill("gamma", "Global gamma."),
      },
    );
    const out = await b.impl.preamble({ sessionId: "s1", role: "owner" });
    expect(out).toContain("## Skills");
    expect(out).toContain("- alpha: Project alpha.");
    expect(out).toContain("- beta: Does beta things.");
    expect(out).toContain("- gamma: Global gamma.");
    expect(out).not.toContain("shadowed");
    expect(out.indexOf("## Skills")).toBeGreaterThan(out.indexOf("# Persona"));
  });

  test("lists bodies nowhere, and the build system prompt carries the same section", async () => {
    const { b } = await setup({ "skills/alpha/SKILL.md": skill("alpha", "Does alpha.") });
    const out = await b.impl.preamble({ sessionId: "s1", role: "owner" });
    expect(out).not.toContain("Body of alpha");
    const built = await b.impl.build({ sessionId: "s1", runId: "r", model: model(100_000), role: "owner" });
    expect(built.system).toContain("- alpha: Does alpha.");
  });

  test("skills are owner-only unless the SKILL.md sets minRole", async () => {
    const { b } = await setup({
      "skills/private/SKILL.md": skill("private", "Owner stuff."),
      "skills/open/SKILL.md": skill("open", "For friends.", "minRole: trusted\n"),
    });
    const trusted = await b.impl.preamble({ sessionId: "s1", role: "trusted" });
    expect(trusted).toContain("- open:");
    expect(trusted).not.toContain("private");
    const guest = await b.impl.preamble({ sessionId: "s1", role: "guest" });
    expect(guest).not.toContain("## Skills");
  });

  test("no skills means no section; a skill without a description is skipped with a warning", async () => {
    const { b } = await setup({ "skills/bare/SKILL.md": "---\nname: bare\n---\nbody" });
    expect(await b.impl.preamble({ sessionId: "s1", role: "owner" })).not.toContain("## Skills");
    expect(b.warns.some((w) => w.msg.includes("no description"))).toBe(true);
  });

  test("project settings can turn skills off or replace the folders", async () => {
    const files = {
      "skills/alpha/SKILL.md": skill("alpha", "Default folder."),
      "other/delta/SKILL.md": skill("delta", "Custom folder."),
    };
    const off = await setup(files, { skills: { enabled: false } });
    expect(await off.b.impl.preamble({ sessionId: "s1", role: "owner" })).not.toContain("## Skills");
    expect(await off.b.skillTools("s1", "owner")).toEqual([]);
    const custom = await setup(files, { skills: { paths: ["other"] } });
    const out = await custom.b.impl.preamble({ sessionId: "s1", role: "owner" });
    expect(out).toContain("- delta: Custom folder.");
    expect(out).not.toContain("Default folder");
  });

  test("plugin config turns skills off for every project", async () => {
    const { b } = await setup({ "skills/alpha/SKILL.md": skill("alpha", "Does alpha.") });
    b.setConfig({ skillsEnabled: false });
    expect(await b.impl.preamble({ sessionId: "s1", role: "owner" })).not.toContain("## Skills");
  });

  test("a long list is capped and says how many were left out", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 65; i++)
      files[`skills/s${String(i).padStart(2, "0")}/SKILL.md`] = skill(`s${i}`, "d");
    const { b } = await setup(files);
    expect(await b.impl.preamble({ sessionId: "s1", role: "owner" })).toContain("- (5 more not listed)");
  });
});

describe("skill_read", () => {
  test("is only offered when the run can see a skill", async () => {
    const { b } = await setup({ "skills/alpha/SKILL.md": skill("alpha", "Does alpha.") });
    expect((await b.skillTools("s1", "owner")).map((t) => t.name)).toEqual(["skill_read"]);
    expect(await b.skillTools("s1", "guest")).toEqual([]);
    expect((await boot().skillTools("nope", "owner")).length).toBe(0);
  });

  test("returns the body without frontmatter, the directory and the bundled files", async () => {
    const { b, dir } = await setup({
      "skills/alpha/SKILL.md": skill("alpha", "Does alpha."),
      "skills/alpha/scripts/run.sh": "echo hi",
      "skills/alpha/node_modules/x/y.js": "skip me",
    });
    const tool = await skillRead(b);
    const out = text(await (tool as ToolDefinition<{ name: string }>).invoke({ name: "ALPHA" }, call()));
    expect(out).toContain("# Skill: alpha");
    expect(out).toContain(`Directory: ${join(dir, "skills/alpha")}`);
    expect(out).toContain("Body of alpha.");
    expect(out).not.toContain("description:");
    expect(out).toContain("- scripts/run.sh");
    expect(out).not.toContain("node_modules");
  });

  test("reads a bundled file, and rejects escapes, symlinks out, binaries and unknown names", async () => {
    const { b, dir } = await setup({
      "skills/alpha/SKILL.md": skill("alpha", "Does alpha."),
      "skills/alpha/notes.md": "bundled notes",
      "skills/alpha/blob.bin": "ab\0cd",
      "secret.txt": "TOPSECRET",
    });
    await symlink(join(dir, "secret.txt"), join(dir, "skills/alpha/leak.txt"));
    const tool = (await skillRead(b)) as ToolDefinition<{ name: string; file?: string }>;
    const run = (file: string) => tool.invoke({ name: "alpha", file }, call());
    expect(text(await run("notes.md"))).toBe("bundled notes");
    for (const bad of ["../../secret.txt", "leak.txt", "/etc/passwd"]) {
      const r = await run(bad);
      expect(r.isError).toBe(true);
      expect(text(r)).not.toContain("TOPSECRET");
    }
    expect(text(await run("blob.bin"))).toContain("binary");
    expect((await run("missing.md")).isError).toBe(true);
    const unknown = await tool.invoke({ name: "zzz" }, call());
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain("Available: alpha");
  });

  test("a guest call cannot read an owner-only skill even by name", async () => {
    const { b } = await setup({
      "skills/open/SKILL.md": skill("open", "Friends.", "minRole: trusted\n"),
      "skills/private/SKILL.md": skill("private", "Owner only."),
    });
    const tool = (await skillRead(b, "trusted")) as ToolDefinition<{ name: string }>;
    const r = await tool.invoke({ name: "private" }, call("trusted"));
    expect(r.isError).toBe(true);
    expect(text(r)).not.toContain("Body of private");
    expect(text(await tool.invoke({ name: "open" }, call("trusted")))).toContain("Body of open");
  });

  test("follows a symlinked skill directory and sees edits without a restart", async () => {
    const { b, dir } = await setup({
      "elsewhere/linked/SKILL.md": skill("linked", "Via symlink."),
      "skills/.keep": "",
    });
    await symlink(join(dir, "elsewhere/linked"), join(dir, "skills/linked"));
    expect(await b.impl.preamble({ sessionId: "s1", role: "owner" })).toContain("- linked: Via symlink.");
    await mkdir(join(dir, "skills/fresh"), { recursive: true });
    await writeFile(join(dir, "skills/fresh/SKILL.md"), skill("fresh", "Added later."));
    expect(await b.impl.preamble({ sessionId: "s1", role: "owner" })).toContain("- fresh: Added later.");
  });
});
