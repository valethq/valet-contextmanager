import { afterAll, describe, expect, test } from "bun:test";
import { boot, cleanup, entry, model, project, session, text, workspace } from "./helpers";

afterAll(cleanup);

async function bootBuild(messages: ReturnType<typeof entry>[], window = 1_000_000) {
  const dir = await workspace({ "AGENTS.md": "ag" });
  const p = project("p1", dir);
  const s = session("s1", "p1");
  const { impl } = boot({
    sessions: [s],
    projects: [p],
    messages: { s1: messages },
  });
  return { impl, model: model(window) };
}

describe("build", () => {
  test("maps history to ModelMessage with text parts only", async () => {
    const { impl, model: m } = await bootBuild([
      entry("s1", "user", [text("hello")]),
      entry("s1", "assistant", [text("hi there"), { type: "reasoning", text: "hmm" }], {
        runId: "r1",
      }),
      entry("s1", "user", [{ type: "reasoning", text: "no text" }]),
      entry("s1", "assistant", [text("draft")], { runId: "r2" }),
      entry("s1", "tool", [text("tool out")], { meta: { callId: "c1" } }),
      entry("s1", "system", [text("note")]),
    ]);
    const built = await impl.build({ sessionId: "s1", runId: "r2", model: m, role: "owner" });
    expect(built.system).toBe("# Persona\n\n## AGENTS.md\n\nag");
    expect(built.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi there" }] },
      { role: "tool", callId: "c1", content: [{ type: "text", text: "tool out" }] },
      { role: "user", content: [{ type: "text", text: "note" }] },
    ]);
    expect(built.files.map((f) => f.path)).toEqual(["AGENTS.md"]);
    expect(built.estimatedTokens).toBe(
      Math.ceil((built.system.length + "hello".length + "hi there".length + 8 + 4) / 4),
    );
  });

  test("trims oldest messages over 80% of the context window", async () => {
    const long = "x".repeat(100);
    const { impl, model: m } = await bootBuild(
      [
        entry("s1", "user", [text(long)]),
        entry("s1", "assistant", [text(long)]),
        entry("s1", "user", [text(long)]),
        entry("s1", "assistant", [text(long)]),
      ],
      100,
    );
    const built = await impl.build({ sessionId: "s1", runId: "r9", model: m, role: "owner" });
    // budget: 80 tokens = 320 chars; system is 23 chars -> ~2 messages fit
    expect(built.messages).toHaveLength(2);
    expect(Math.ceil((built.system.length + 200) / 4)).toBeLessThanOrEqual(80);
    expect(built.estimatedTokens).toBeLessThanOrEqual(80);
    expect(built.messages[0]?.role).toBe("user");
  });

  test("empty history yields no messages", async () => {
    const { impl, model: m } = await bootBuild([]);
    const built = await impl.build({ sessionId: "s1", runId: "r1", model: m, role: "owner" });
    expect(built.messages).toEqual([]);
  });
});

describe("shouldCompact", () => {
  test("true above 80% of the window, false at/below", async () => {
    const { impl } = boot();
    const m = model(1000);
    expect(await impl.shouldCompact({ sessionId: "s1", model: m, lastUsage: { contextTokens: 801 } })).toBe(
      true,
    );
    expect(await impl.shouldCompact({ sessionId: "s1", model: m, lastUsage: { contextTokens: 800 } })).toBe(
      false,
    );
    expect(await impl.shouldCompact({ sessionId: "s1", model: m, lastUsage: { inputTokens: 900 } })).toBe(
      true,
    );
    expect(await impl.shouldCompact({ sessionId: "s1", model: m, lastUsage: {} })).toBe(false);
  });

  test("false when the window is unknown", async () => {
    const { impl } = boot();
    expect(
      await impl.shouldCompact({ sessionId: "s1", model: model(0), lastUsage: { contextTokens: 9e9 } }),
    ).toBe(false);
  });
});

describe("compact", () => {
  test("throws until M3", async () => {
    const { impl } = boot();
    await expect(impl.compact({ sessionId: "s1", reason: "auto" })).rejects.toThrow(
      "valet-contextmanager: compaction lands in M3",
    );
  });
});
