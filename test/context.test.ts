import { afterAll, describe, expect, test } from "bun:test";
import { AGENTS_RULE_NOTE, boot, cleanup, entry, model, project, session, text, workspace } from "./helpers";

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
    expect(built.system).toBe(
      `# Persona\n\n## AGENTS.md\n\n${AGENTS_RULE_NOTE}\n\nag\n\nContext window: 1000000 tokens (model test-model).`,
    );
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
      140,
    );
    const built = await impl.build({ sessionId: "s1", runId: "r9", model: m, role: "owner" });
    // budget: 112 tokens = 448 chars; system ~174 chars -> ~2 messages fit
    expect(built.messages).toHaveLength(2);
    expect(Math.ceil((built.system.length + 200) / 4)).toBeLessThanOrEqual(112);
    expect(built.estimatedTokens).toBeLessThanOrEqual(112);
    expect(built.messages[0]?.role).toBe("user");
  });

  test("omits the context-window line when the window is unknown", async () => {
    const { impl } = await bootBuild([]);
    const built = await impl.build({ sessionId: "s1", runId: "r1", model: model(0), role: "owner" });
    expect(built.system).toBe(`# Persona\n\n## AGENTS.md\n\n${AGENTS_RULE_NOTE}\n\nag`);
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
  async function setup(messages: ReturnType<typeof entry>[]) {
    const dir = await workspace({ "AGENTS.md": "ag" });
    const store = { s1: messages };
    const { impl } = boot({
      sessions: [session("s1", "p1")],
      projects: [project("p1", dir)],
      messages: store,
    });
    return { impl, store, model: model(1_000_000) };
  }
  const valet = (summary: string, seen: string[] = []) => ({
    kind: "valet" as const,
    summarize: async (t: string) => {
      seen.push(t);
      return summary;
    },
  });
  const prompt = (sessionId: string) => ({ sessionId, runId: "r9", role: "owner" as const });

  test("valet summarizes the chat in place, and history starts from the summary", async () => {
    const {
      impl,
      store,
      model: m,
    } = await setup([
      entry("s1", "user", [text("old question")]),
      entry("s1", "assistant", [text("old answer")], { runId: "r1" }),
    ]);
    const seen: string[] = [];
    await impl.compact({ sessionId: "s1", reason: "manual", by: valet("SUMMARY", seen) });
    expect(seen).toEqual(["user: old question\n\nassistant: old answer"]);
    const last = store.s1[1]?.message.seq ?? -1;
    expect(store.s1.at(-1)?.parts[0]?.data).toEqual({
      type: "compaction",
      by: "valet",
      coversThroughSeq: last,
      summary: "SUMMARY",
    });
    store.s1.push(entry("s1", "user", [text("new question")]));
    const built = await impl.build({ ...prompt("s1"), model: m });
    expect(built.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "[valet: summary of the earlier part of this chat, compacted by valet]\nSUMMARY",
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "new question" }] },
    ]);
  });

  test("a second valet compaction folds the earlier summary into the new one", async () => {
    const { impl, store } = await setup([entry("s1", "user", [text("first")])]);
    await impl.compact({ sessionId: "s1", reason: "manual", by: valet("ONE") });
    store.s1.push(entry("s1", "assistant", [text("second")], { runId: "r2" }));
    const seen: string[] = [];
    await impl.compact({ sessionId: "s1", reason: "auto", by: valet("TWO", seen) });
    expect(seen).toEqual(["Earlier summary:\nONE\n\nassistant: second"]);
  });

  test("a harness marker is recorded but leaves valet's history untouched", async () => {
    const { impl, store, model: m } = await setup([entry("s1", "user", [text("hello")])]);
    const covers = store.s1[0]?.message.seq ?? -1;
    await impl.compact({ sessionId: "s1", reason: "auto", by: { kind: "harness", label: "Claude Code" } });
    expect(store.s1.at(-1)?.parts[0]?.data).toEqual({
      type: "compaction",
      by: "Claude Code",
      coversThroughSeq: covers,
    });
    const built = await impl.build({ ...prompt("s1"), model: m });
    expect(built.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  });

  test("valet refuses an empty chat", async () => {
    const { impl } = await setup([]);
    await expect(impl.compact({ sessionId: "s1", reason: "manual", by: valet("x") })).rejects.toThrow(
      "nothing to compact yet",
    );
  });
});
