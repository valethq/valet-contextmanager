import { afterAll, describe, expect, test } from "bun:test";
import { boot, cleanup, dayKey, project, session, workspace } from "./helpers";

afterAll(cleanup);

const allFiles = () => {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return {
    "AGENTS.md": "agents content",
    "SOUL.md": "soul content",
    "IDENTITY.md": "identity content",
    "USER.md": "user content",
    "MEMORY.md": "memory content",
    [`memory/${dayKey(yesterday)}.md`]: "yesterday daily",
    [`memory/${dayKey(today)}.md`]: "today daily",
  };
};

async function bootWith(dir: string, settings: Record<string, unknown> = {}) {
  const p = project("p1", dir, settings);
  const s = session("s1", "p1");
  return boot({ sessions: [s], projects: [p] });
}

describe("scope registration", () => {
  test("defines context@1 and provides it under valet-contextmanager", () => {
    const { defined, provided } = boot();
    expect(defined).toEqual([{ name: "context", version: 1, cardinality: "one" }]);
    expect(provided).toHaveLength(1);
    expect(provided[0]?.scope).toBe("context");
    expect(provided[0]?.key).toBe("valet-contextmanager");
  });
});

describe("preamble", () => {
  test("loads default files in order under headed sections", async () => {
    const dir = await workspace(allFiles());
    const { impl } = await bootWith(dir);
    const out = await impl.preamble({ sessionId: "s1", role: "owner" });
    expect(out.startsWith("# Persona\n\n## AGENTS.md\n\nagents content")).toBe(true);
    const order = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md", "memory/"];
    let at = 0;
    for (const h of order) {
      const i = out.indexOf(`## ${h}`);
      expect(i).toBeGreaterThan(at);
      at = i;
    }
    const y = new Date();
    y.setDate(y.getDate() - 1);
    expect(out.indexOf(`## memory/${dayKey(y)}.md`)).toBeLessThan(
      out.indexOf(`## memory/${dayKey(new Date())}.md`),
    );
  });

  test("owner sees MEMORY.md and daily files, trusted does not", async () => {
    const dir = await workspace(allFiles());
    const { impl } = await bootWith(dir);
    const owner = await impl.preamble({ sessionId: "s1", role: "owner" });
    expect(owner).toContain("## MEMORY.md");
    expect(owner).toContain("## memory/");
    const trusted = await impl.preamble({ sessionId: "s1", role: "trusted" });
    expect(trusted).not.toContain("MEMORY.md");
    expect(trusted).not.toContain("memory/");
    expect(trusted).toContain("## USER.md");
    const guest = await impl.preamble({ sessionId: "s1", role: "guest" });
    expect(guest).not.toContain("MEMORY.md");
  });

  test("injects the two most recent daily notes on or before today, older first", async () => {
    const at = (offset: number) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return dayKey(d);
    };
    const dir = await workspace({
      [`memory/${at(-8)}.md`]: "old daily",
      [`memory/${at(-4)}.md`]: "recent daily",
      [`memory/${at(0)}.md`]: "today daily",
      [`memory/${at(10)}.md`]: "future daily",
      "memory/notes.md": "not a daily",
    });
    const { impl } = await bootWith(dir);
    const out = await impl.preamble({ sessionId: "s1", role: "owner" });
    const recent = out.indexOf(`## memory/${at(-4)}.md`);
    const today = out.indexOf(`## memory/${at(0)}.md`);
    expect(recent).toBeGreaterThan(-1);
    expect(today).toBeGreaterThan(recent);
    expect(out).toContain("recent daily");
    expect(out).toContain("today daily");
    expect(out).not.toContain("old daily");
    expect(out).not.toContain("future daily");
    expect(out).not.toContain("not a daily");
  });

  test("a 40,000-byte AGENTS.md arrives intact, last line included", async () => {
    const lastLine = "END-OF-PERSONA-FILE";
    const content = `${"x".repeat(40_000 - lastLine.length - 1)}\n${lastLine}`;
    const dir = await workspace({ "AGENTS.md": content });
    const { impl, warns } = await bootWith(dir);
    const out = await impl.preamble({ sessionId: "s1", role: "owner" });
    expect(out).toBe(`# Persona\n\n## AGENTS.md\n\n${content}`);
    expect(out.endsWith(lastLine)).toBe(true);
    expect(out).not.toContain("[valet: truncated");
    expect(warns).toHaveLength(0);
  });

  test("preamble has no model, so no context-window line", async () => {
    const dir = await workspace({ "AGENTS.md": "ag" });
    const { impl } = await bootWith(dir);
    const out = await impl.preamble({ sessionId: "s1", role: "owner" });
    expect(out).not.toContain("Context window:");
  });

  test("missing files are skipped silently", async () => {
    const dir = await workspace({ "SOUL.md": "only soul" });
    const { impl, warns } = await bootWith(dir);
    const out = await impl.preamble({ sessionId: "s1", role: "owner" });
    expect(out).toBe("# Persona\n\n## SOUL.md\n\nonly soul");
    expect(warns).toHaveLength(0);
  });

  test("over-cap file keeps cap bytes, appends marker and warns", async () => {
    const dir = await workspace({ "AGENTS.md": "x".repeat(20) });
    const { impl, warns } = await bootWith(dir, { persona: { maxBytesPerFile: 10 } });
    const out = await impl.preamble({ sessionId: "s1", role: "owner" });
    expect(out).toBe(
      `# Persona\n\n## AGENTS.md\n\n${"x".repeat(10)}\n\n[valet: truncated 10 bytes over the per-file cap]`,
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]?.data?.path).toBe("AGENTS.md");
  });

  test("project settings can replace the file list", async () => {
    const dir = await workspace({ "B.md": "b content", "A.md": "a content" });
    const { impl } = await bootWith(dir, {
      persona: {
        files: [
          { path: "B.md", role: "other" },
          { path: "A.md", role: "soul", minRole: "owner" },
        ],
      },
    });
    const owner = await impl.preamble({ sessionId: "s1", role: "owner" });
    expect(owner).toBe("# Persona\n\n## B.md\n\nb content\n\n## A.md\n\na content");
    const guest = await impl.preamble({ sessionId: "s1", role: "guest" });
    expect(guest).toBe("# Persona\n\n## B.md\n\nb content");
  });
});
