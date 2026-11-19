import { afterAll, describe, expect, test } from "bun:test";
import type { ModelInfo, ModelMessage, PartData } from "@valethq/sdk";
import { boot, cleanup, entry, model, project, session, text, workspace } from "./helpers";

afterAll(cleanup);

const HEAD = "[valet: summary of the earlier part of this chat, compacted by valet]";

function info(window: number, patch: Partial<ModelInfo> = {}): ModelInfo {
  return { ...model(window), ...patch };
}

async function setup(messages: ReturnType<typeof entry>[]) {
  const dir = await workspace({ "AGENTS.md": "ag" });
  const store = { s1: messages };
  const booted = boot({
    sessions: [session("s1", "p1")],
    projects: [project("p1", dir)],
    messages: store,
  });
  return { ...booted, store };
}

function buildReq(m: ModelInfo, runId = "current") {
  return { sessionId: "s1", runId, model: m, role: "owner" as const };
}

const file = (name: string, mime: string, blobId = "blb_1"): PartData => ({
  type: "file",
  blobId,
  name,
  mime,
});

type ToolCall = Extract<PartData, { type: "tool-call" }>;

function call(callId: string, status: ToolCall["status"], extra: Partial<ToolCall> = {}): ToolCall {
  return { type: "tool-call", callId, name: "exec", input: { cmd: callId }, status, ...extra };
}

function compaction(
  by: string,
  status: Extract<PartData, { type: "compaction" }>["status"],
  coversThroughSeq: number,
  summary?: string,
): PartData {
  return {
    type: "compaction",
    by,
    status,
    coversThroughSeq,
    ...(summary === undefined ? {} : { summary }),
  };
}

function assertPairs(messages: ModelMessage[]) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    const ids = m.content.flatMap((c) => (c.type === "tool-call" ? [c.callId] : []));
    for (let k = 0; k < ids.length; k++) {
      expect(messages[i + 1 + k]).toMatchObject({ role: "tool", callId: ids[k] });
    }
    if (ids.length > 0) expect(messages[i + 1 + ids.length]?.role).not.toBe("tool");
  }
  for (const [i, m] of messages.entries()) {
    if (m.role !== "tool") continue;
    const prev = messages[i - 1];
    const owned =
      prev?.role === "tool" ||
      (prev?.role === "assistant" &&
        prev.content.some((c) => c.type === "tool-call" && c.callId === m.callId));
    expect(owned).toBe(true);
  }
}

describe("tool calls", () => {
  test("replays tool calls with their results, then later text as a new assistant message", async () => {
    const { impl } = await setup([
      entry("s1", "user", [text("go")]),
      entry(
        "s1",
        "assistant",
        [
          text("checking"),
          call("c1", "done", { output: "one" }),
          call("c2", "done", {
            output: "ignored",
            result: { content: [{ type: "text", text: "two" }] },
          }),
          text("done"),
          text("really"),
        ],
        { runId: "past" },
      ),
      entry("s1", "assistant", [text("live"), call("c9", "done", { output: "nope" })], { runId: "current" }),
    ]);
    const built = await impl.build(buildReq(info(1_000_000)));
    expect(built.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "tool-call", callId: "c1", name: "exec", input: { cmd: "c1" } },
          { type: "tool-call", callId: "c2", name: "exec", input: { cmd: "c2" } },
        ],
      },
      { role: "tool", callId: "c1", content: [{ type: "text", text: "one" }] },
      { role: "tool", callId: "c2", content: [{ type: "text", text: "two" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done" },
          { type: "text", text: "really" },
        ],
      },
    ]);
    assertPairs(built.messages);
  });

  test("keeps a tool-only assistant message", async () => {
    const { impl } = await setup([
      entry("s1", "assistant", [call("c1", "done", { output: "out" })], { runId: "past" }),
    ]);
    const built = await impl.build(buildReq(info(1_000_000)));
    expect(built.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool-call", callId: "c1", name: "exec", input: { cmd: "c1" } }],
      },
      { role: "tool", callId: "c1", content: [{ type: "text", text: "out" }] },
    ]);
  });

  test("marks error, denied and cancelled calls, and closes pending or running ones", async () => {
    const { impl } = await setup([
      entry(
        "s1",
        "assistant",
        [
          call("e", "error", { output: "boom" }),
          call("d", "denied", { output: "no" }),
          call("x", "cancelled", {
            output: "stop",
            result: {
              content: [
                { type: "text", text: "stopped" },
                { type: "image", mime: "image/png", blobId: "blb_9" },
              ],
            },
          }),
          call("p", "pending", { output: "partial" }),
          call("r", "running", { result: { content: [{ type: "text", text: "partial" }] } }),
          call("z", "done", { output: "fallback", result: { content: [] } }),
        ],
        { runId: "past" },
      ),
    ]);
    const built = await impl.build(buildReq(info(1_000_000)));
    expect(built.messages.slice(1)).toEqual([
      { role: "tool", callId: "e", content: [{ type: "text", text: "boom" }], isError: true },
      { role: "tool", callId: "d", content: [{ type: "text", text: "no" }], isError: true },
      {
        role: "tool",
        callId: "x",
        content: [
          { type: "text", text: "stopped" },
          { type: "image", mime: "image/png", blobId: "blb_9" },
        ],
        isError: true,
      },
      { role: "tool", callId: "p", content: [{ type: "text", text: "interrupted" }] },
      { role: "tool", callId: "r", content: [{ type: "text", text: "interrupted" }] },
      { role: "tool", callId: "z", content: [] },
    ]);
    assertPairs(built.messages);
  });
});

describe("images", () => {
  test("sends image file parts only when the model accepts images", async () => {
    const { impl } = await setup([
      entry("s1", "user", [
        text("look"),
        file("a.png", "image/png", "blb_a"),
        file("b.txt", "text/plain", "blb_b"),
      ]),
      entry("s1", "assistant", [file("c.webp", "image/webp", "blb_c"), text("done")], { runId: "past" }),
    ]);
    const vision = await impl.build(buildReq(info(1_000_000, { input: ["text", "image"] })));
    expect(vision.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", mime: "image/png", blobId: "blb_a" },
          { type: "text", text: "[attached: b.txt (text/plain)]" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "image", mime: "image/webp", blobId: "blb_c" },
          { type: "text", text: "done" },
        ],
      },
    ]);
    const blind = await impl.build(buildReq(info(1_000_000)));
    expect(blind.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "text", text: "[attached: a.png (image/png)]" },
        { type: "text", text: "[attached: b.txt (text/plain)]" },
      ],
    });
  });
});

describe("compaction transcript and summary cut", () => {
  test("transcript includes tool calls, clipped output and file notes", async () => {
    const long = `${"o".repeat(2_000)}TAIL`;
    const { impl } = await setup([
      entry("s1", "user", [text("look"), file("a.png", "image/png")]),
      entry(
        "s1",
        "assistant",
        [
          text("checking"),
          call("c1", "done", {
            input: { cmd: "ls" },
            result: {
              content: [
                { type: "text", text: "file.txt" },
                { type: "image", mime: "image/png", blobId: "blb" },
              ],
            },
          }),
          text("done"),
        ],
        { runId: "past" },
      ),
      entry("s1", "user", [file("notes.txt", "text/plain")]),
      entry("s1", "assistant", [call("c2", "done", { input: { cmd: "cat" }, output: long })], {
        runId: "past",
      }),
      entry("s1", "assistant", [file("out.txt", "text/plain")], { runId: "past" }),
      entry("s1", "system", [
        { type: "custom", kind: "k", title: "TITLE-HIDDEN", text: "body text", data: { a: 1 } },
      ]),
    ]);
    const seen: string[] = [];
    await impl.compact({
      sessionId: "s1",
      reason: "manual",
      summarize: async (t) => {
        seen.push(t);
        return "ok";
      },
    });
    expect(seen).toEqual([
      [
        "user: look\n[attached: a.png (image/png)]",
        'assistant: checking\n[tool exec input={"cmd":"ls"} output=file.txt\n[image image/png]]\ndone',
        "user: [attached: notes.txt (text/plain)]",
        `assistant: [tool exec input={"cmd":"cat"} output=${"o".repeat(2_000)}... [4 more chars]]`,
        "assistant: [presented to the user: out.txt (text/plain)]",
        "system: body text",
      ].join("\n\n"),
    ]);
    expect(seen[0]).not.toContain("TAIL");
    expect(seen[0]).not.toContain("TITLE-HIDDEN");
  });

  test("only a completed valet summary with text cuts history", async () => {
    const keep = entry("s1", "user", [text("keep-me")]);
    const { impl } = await setup([
      keep,
      entry("s1", "system", [compaction("valet", "completed", keep.message.seq, "   \n")]),
      entry("s1", "system", [compaction("Claude Code", "completed", keep.message.seq, "HARNESS")]),
      entry("s1", "system", [compaction("valet", "failed", keep.message.seq, "NOPE")]),
      entry("s1", "system", [compaction("valet", "in_progress", keep.message.seq, "OPEN")]),
    ]);
    const built = await impl.build(buildReq(info(1_000_000)));
    expect(built.messages).toEqual([{ role: "user", content: [{ type: "text", text: "keep-me" }] }]);
  });

  test("a valet summary wins over a later harness compaction", async () => {
    const hidden = entry("s1", "user", [text("hidden-turn")]);
    const after = entry("s1", "user", [text("after")]);
    const { impl } = await setup([
      hidden,
      entry("s1", "system", [compaction("valet", "completed", hidden.message.seq, "  Real summary  ")]),
      after,
      entry("s1", "system", [compaction("Claude Code", "completed", after.message.seq, "HARNESS")]),
    ]);
    const built = await impl.build(buildReq(info(1_000_000)));
    expect(built.messages).toEqual([
      { role: "user", content: [{ type: "text", text: `${HEAD}\nReal summary` }] },
      { role: "user", content: [{ type: "text", text: "after" }] },
    ]);
  });

  test("a blank summarize() result fails the compaction and leaves history", async () => {
    const { impl, store } = await setup([entry("s1", "user", [text("hello")])]);
    await expect(
      impl.compact({ sessionId: "s1", reason: "manual", summarize: async () => "  \n\t" }),
    ).rejects.toThrow("compaction summary was empty");
    expect(store.s1.at(-1)?.parts[0]?.data).toMatchObject({
      type: "compaction",
      by: "valet",
      status: "failed",
      error: "compaction summary was empty",
    });
    expect(store.s1.at(-1)?.parts[0]?.data).not.toHaveProperty("summary");
    const built = await impl.build(buildReq(info(1_000_000)));
    expect(built.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hello" }] }]);
  });

  test("compact stores the trimmed summary", async () => {
    const { impl, store } = await setup([entry("s1", "user", [text("hello")])]);
    await impl.compact({ sessionId: "s1", reason: "auto", summarize: async () => "  folded  " });
    expect(store.s1.at(-1)?.parts[0]?.data).toMatchObject({ status: "completed", summary: "folded" });
  });
});

describe("trimming", () => {
  test("a low compactionThreshold does not trim when the window minus reserve still fits", async () => {
    const booted = await setup(
      ["A", "B", "C"].map((id) => entry("s1", "user", [text(`${id} ${"x".repeat(500)}`)])),
    );
    booted.setConfig({ compactionThreshold: 0.01 });
    const built = await booted.impl.build(buildReq(info(10_000, { maxOutputTokens: 0 })));
    expect(built.messages).toHaveLength(3);
    expect(built.messages.map((m) => (m.role === "user" ? m.content[0] : undefined))).toEqual([
      { type: "text", text: `A ${"x".repeat(500)}` },
      { type: "text", text: `B ${"x".repeat(500)}` },
      { type: "text", text: `C ${"x".repeat(500)}` },
    ]);
  });

  test("drops an older tool pair and keeps the latest user message", async () => {
    const { impl } = await setup([
      entry("s1", "user", [text(`OLD ${"o".repeat(8_000)}`)]),
      entry("s1", "assistant", [call("c-old", "done", { output: "OLD-OUTPUT" })], { runId: "past" }),
      entry("s1", "user", [text("STAY")]),
    ]);
    const built = await impl.build(buildReq(info(200, { maxOutputTokens: 40 })));
    expect(built.messages).toEqual([{ role: "user", content: [{ type: "text", text: "STAY" }] }]);
  });

  test("keeps the summary and the latest user turn, including its tool pair, when still over budget", async () => {
    const old = entry("s1", "user", [text(`OLD ${"o".repeat(4_000)}`)]);
    const booted = await setup([
      old,
      entry("s1", "system", [compaction("valet", "completed", old.message.seq, "KEEP-SUM")]),
      entry(
        "s1",
        "assistant",
        [text("call-old"), call("c-old", "done", { output: `OLD-OUTPUT ${"z".repeat(4_000)}` })],
        {
          runId: "past",
        },
      ),
      entry("s1", "user", [text("STAY")]),
      entry(
        "s1",
        "assistant",
        [text("on it"), call("c-new", "done", { output: `NEW-OUTPUT ${"n".repeat(4_000)}` })],
        { runId: "past" },
      ),
    ]);
    booted.setConfig({ compactionThreshold: 0.01 });
    const built = await booted.impl.build(buildReq(info(300, { maxOutputTokens: 50 })));
    expect(built.messages.map((m) => m.role)).toEqual(["user", "user", "assistant", "tool"]);
    const blob = JSON.stringify(built.messages);
    expect(blob).toContain("KEEP-SUM");
    expect(blob).toContain("STAY");
    expect(blob).toContain("NEW-OUTPUT");
    expect(blob).not.toContain("OLD-OUTPUT");
    expect(blob).not.toContain("call-old");
    expect(built.messages[1]?.role).toBe("user");
    expect(built.estimatedTokens).toBeGreaterThan(250);
    assertPairs(built.messages);
  });

  test("leaves a leading assistant in place when the history fits", async () => {
    const { impl } = await setup([
      entry("s1", "assistant", [text("first")], { runId: "past" }),
      entry("s1", "user", [text("second")]),
    ]);
    const built = await impl.build(buildReq(info(1_000_000)));
    expect(built.messages.map((m) => m.role)).toEqual(["assistant", "user"]);
  });
});
