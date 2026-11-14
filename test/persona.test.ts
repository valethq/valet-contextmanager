import { afterAll, describe, expect, test } from "bun:test";
import { AGENTS_RULE_NOTE, boot, cleanup, dayKey, project, session, workspace } from "./helpers";

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
    expect(defined).toEqual([
      { name: "context", version: 1, cardinality: "one" },
      { name: "settings", version: 1, cardinality: "many" },
    ]);
    const context = provided.find((p) => p.scope === "context");
    expect(context?.key).toBe("valet-contextmanager");
  });
});

describe("preamble", () => {
  test("loads default files in order under headed sections", async () => {
    const dir = await workspace(allFiles());
    const { impl } = await bootWith(dir);
    const out = await impl.preamble({ sessionId: "s1", role: "owner" });
    expect(out.startsWith(`# Persona\n\n## AGENTS.md\n\n${AGENTS_RULE_NOTE}\n\nagents content`)).toBe(true);
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
    expect(out).toBe(`# Persona\n\n## AGENTS.md\n\n${AGENTS_RULE_NOTE}\n\n${content}`);
    expect(out.endsWith(lastLine)).toBe(true);
    expect(out).not.toContain("[valet: truncated");
    expect(warns).toHaveLength(0);
  });

  test("rule note sits directly under the AGENTS.md heading, only there", async () => {
    const dir = await workspace(allFiles());
    const { impl } = await bootWith(dir);
    const out = await impl.preamble({ sessionId: "s1", role: "owner" });
    expect(out).toContain(`## AGENTS.md\n\n${AGENTS_RULE_NOTE}\n\nagents content`);
    expect(out.indexOf(AGENTS_RULE_NOTE)).toBe(out.lastIndexOf(AGENTS_RULE_NOTE));
    const soul = out.indexOf("## SOUL.md");
    expect(out.slice(soul, soul + 300)).not.toContain(AGENTS_RULE_NOTE);
  });

  test("preamble without model prints no context-window line", async () => {
    const dir = await workspace({ "AGENTS.md": "ag" });
    const { impl } = await bootWith(dir);
    const out = await impl.preamble({ sessionId: "s1", role: "owner" });
    expect(out).not.toContain("Context window:");
  });

  test("preamble with model ends with the same context-window line build() uses", async () => {
    const dir = await workspace({ "AGENTS.md": "ag" });
    const { impl } = await bootWith(dir);
    const out = await impl.preamble({
      sessionId: "s1",
      role: "owner",
      model: { id: "test-model", contextWindow: 1_000_000 },
    });
    expect(out.endsWith("Context window: 1000000 tokens (model test-model).")).toBe(true);
    expect(out).toBe(
      `# Persona\n\n## AGENTS.md\n\n${AGENTS_RULE_NOTE}\n\nag\n\nContext window: 1000000 tokens (model test-model).`,
    );
  });

  test("preamble omits the context-window line for zero/unknown window", async () => {
    const dir = await workspace({ "AGENTS.md": "ag" });
    const { impl } = await bootWith(dir);
    const zero = await impl.preamble({
      sessionId: "s1",
      role: "owner",
      model: { id: "test-model", contextWindow: 0 },
    });
    expect(zero).not.toContain("Context window:");
    const unknown = await impl.preamble({
      sessionId: "s1",
      role: "owner",
      model: { id: "test-model" },
    });
    expect(unknown).not.toContain("Context window:");
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
      `# Persona\n\n## AGENTS.md\n\n${AGENTS_RULE_NOTE}\n\n${"x".repeat(10)}\n\n[valet: truncated 10 bytes over the per-file cap]`,
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

describe("patterns", () => {
  test("loads files matching each regex, in pattern order, replacing the defaults", async () => {
    const dir = await workspace({
      "AGENTS.md": "agents content",
      "README.md": "readme content",
      "docs/b.md": "doc b",
      "docs/a.md": "doc a",
      "src/x.ts": "code x",
    });
    const { impl } = await bootWith(dir, { persona: { patterns: ["^README\\.md$", "^docs/.*\\.md$"] } });
    const out = await impl.preamble({ sessionId: "s1", role: "owner" });
    expect(out).toBe(
      "# Persona\n\n## README.md\n\nreadme content\n\n## docs/a.md\n\ndoc a\n\n## docs/b.md\n\ndoc b",
    );
  });

  test("a file matched by several patterns loads once", async () => {
    const dir = await workspace({ "docs/a.md": "doc a" });
    const { impl } = await bootWith(dir, { persona: { patterns: ["\\.md$", "^docs/"] } });
    const out = await impl.preamble({ sessionId: "s1", role: "owner" });
    expect(out).toBe("# Persona\n\n## docs/a.md\n\ndoc a");
  });

  test("explicit files come first and are not repeated by a pattern", async () => {
    const dir = await workspace({ "A.md": "a content", "B.md": "b content" });
    const { impl } = await bootWith(dir, {
      persona: { files: [{ path: "B.md", role: "soul" }], patterns: ["\\.md$"] },
    });
    const out = await impl.preamble({ sessionId: "s1", role: "owner" });
    expect(out).toBe("# Persona\n\n## B.md\n\nb content\n\n## A.md\n\na content");
  });

  test("an empty patterns array with no files loads nothing", async () => {
    const dir = await workspace({ "AGENTS.md": "ag" });
    const { impl } = await bootWith(dir, { persona: { patterns: [] } });
    const out = await impl.preamble({ sessionId: "s1", role: "owner" });
    expect(out).toBe("# Persona");
  });

  test("skips .git and node_modules, and matches forward-slash relative paths", async () => {
    const dir = await workspace({
      ".git/config.md": "git",
      "node_modules/pkg/readme.md": "dep",
      "packages/core/notes.md": "nested",
    });
    const { impl } = await bootWith(dir, { persona: { patterns: ["\\.md$", "^packages/core/"] } });
    const out = await impl.preamble({ sessionId: "s1", role: "owner" });
    expect(out).toBe("# Persona\n\n## packages/core/notes.md\n\nnested");
  });

  test("invalid regex is skipped with a warning, other patterns still load", async () => {
    const dir = await workspace({ "A.md": "a content" });
    const { impl, warns } = await bootWith(dir, { persona: { patterns: ["(unclosed", "^A\\.md$", 42] } });
    const out = await impl.preamble({ sessionId: "s1", role: "owner" });
    expect(out).toBe("# Persona\n\n## A.md\n\na content");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.data?.pattern).toBe("(unclosed");
  });

  test("matched files obey the per-file cap", async () => {
    const dir = await workspace({ "big.md": "x".repeat(20) });
    const { impl } = await bootWith(dir, { persona: { patterns: ["^big\\.md$"], maxBytesPerFile: 10 } });
    const out = await impl.preamble({ sessionId: "s1", role: "owner" });
    expect(out).toBe(
      `# Persona\n\n## big.md\n\n${"x".repeat(10)}\n\n[valet: truncated 10 bytes over the per-file cap]`,
    );
  });
});
