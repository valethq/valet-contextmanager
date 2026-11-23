import { afterAll, describe, expect, test } from "bun:test";
import type { Message, Part, ToolCall } from "@valethq/sdk";
import { boot, caller, cleanup, entry, project, session, text } from "./helpers";

afterAll(cleanup);

type Entry = { message: Message; parts: Part[] };

function setup(messages: Record<string, Entry[]>, titles: Record<string, string> = {}) {
  const sessions = Object.keys(messages).map((id) => ({ ...session(id, "p1"), title: titles[id] ?? null }));
  const b = boot({ sessions, projects: [project("p1", "/tmp")], messages });
  const tool = (name: string) => {
    const t = b.tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return async (input: Record<string, unknown>, role = "owner") => {
      const r = await t.invoke(input, { role, cwd: "/", caller: caller() } as unknown as ToolCall);
      return { isError: r.isError, text: r.content.map((c) => (c.type === "text" ? c.text : "")).join("") };
    };
  };
  return { ...b, search: tool("session_search"), view: tool("session_view"), messages };
}

describe("session_search", () => {
  test("finds messages across sessions with session id, title and message number", async () => {
    const { search } = setup(
      {
        s1: [
          entry("s1", "user", [text("how do I renew the coturn certificate")]),
          entry("s1", "assistant", [text("copy it from caddy")]),
        ],
        s2: [entry("s2", "user", [text("tune the osu tablet area")])],
      },
      { s1: "Coturn certs", s2: "Tablet" },
    );
    const r = await search({ query: "coturn certificate" });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("1 match");
    expect(r.text).toContain('s1 "Coturn certs" - message');
    expect(r.text).toContain("[[coturn]]");
    expect(r.text).not.toContain("s2");
  });

  test("stems words, falls back to any-word matching, and reports no match", async () => {
    const { search } = setup({
      s1: [entry("s1", "assistant", [text("restarting the gateway fixed it")])],
      s2: [entry("s2", "user", [text("unrelated banana bread")])],
    });
    expect((await search({ query: "restart gateways" })).text).toContain("s1");
    expect((await search({ query: "gateway banana" })).text).toContain("2 matches");
    expect((await search({ query: "zzzz" })).text).toBe('No sessions match "zzzz".');
    expect((await search({ query: '"())' })).text).toContain("No sessions match");
  });

  test("filters by session and project, honours limit", async () => {
    const { search } = setup({
      s1: [entry("s1", "user", [text("deploy one")]), entry("s1", "user", [text("deploy two")])],
      s2: [entry("s2", "user", [text("deploy three")])],
    });
    expect((await search({ query: "deploy", sessionId: "s2" })).text).toContain("1 match");
    expect((await search({ query: "deploy", projectId: "other" })).text).toContain("No sessions match");
    expect((await search({ query: "deploy", limit: 2 })).text).toContain("2 matches");
  });

  test("indexes compaction summaries, file names and custom parts, but not reasoning or tool calls", async () => {
    const { search } = setup({
      s1: [
        entry("s1", "system", [
          {
            type: "compaction",
            by: "valet",
            status: "completed",
            coversThroughSeq: 3,
            summary: "we chose zebracorn for the cache",
          },
        ]),
        entry("s1", "user", [
          { type: "file", blobId: "b", name: "invoice-march.pdf", mime: "application/pdf" },
        ]),
        entry("s1", "assistant", [
          { type: "reasoning", text: "secretthought" },
          { type: "tool-call", callId: "c", name: "exec", input: { cmd: "toolonlyword" }, status: "done" },
        ]),
      ],
    });
    expect((await search({ query: "zebracorn" })).text).toContain("1 match");
    expect((await search({ query: "invoice" })).text).toContain("1 match");
    expect((await search({ query: "secretthought" })).text).toContain("No sessions");
    expect((await search({ query: "toolonlyword" })).text).toContain("No sessions");
  });

  test("picks up new and completed messages and forgets deleted sessions", async () => {
    const { search, fire, messages } = setup({ s1: [entry("s1", "user", [text("hello")])] });
    await search({ query: "hello" });

    const created = entry("s1", "user", [text("brand new lemonade")]);
    messages.s1?.push(created);
    await fire("message.create", { message: created.message, parts: created.parts });
    expect((await search({ query: "lemonade" })).text).toContain("1 match");

    const streaming = entry("s1", "assistant", [text("partial pineapple")], { status: "streaming" });
    messages.s1?.push(streaming);
    await fire("message.create", { message: streaming.message, parts: streaming.parts });
    expect((await search({ query: "pineapple" })).text).toContain("No sessions");
    await fire("message.complete", { message: { ...streaming.message, status: "complete" } });
    expect((await search({ query: "pineapple" })).text).toContain("1 match");

    await fire("session.delete", { session: session("s1", "p1") });
    expect((await search({ query: "lemonade" })).text).toContain("No sessions");
  });
});

describe("session_view", () => {
  const many = () =>
    Array.from({ length: 30 }, (_, i) => {
      const e = entry("s1", i % 2 === 0 ? "user" : "assistant", [text(`line number ${i + 1}`)]);
      e.message.seq = i + 1;
      return e;
    });

  test("shows the latest messages by default, with paging hints", async () => {
    const { view } = setup({ s1: many() }, { s1: "Long chat" });
    const r = await view({ sessionId: "s1", limit: 5 });
    expect(r.text).toContain('Session s1 "Long chat"');
    expect(r.text).toContain("line number 30");
    expect(r.text).not.toContain("line number 25\n");
    expect(r.text).toContain("Showing messages 26-30 of 30.");
    expect(r.text).toContain("Older: session_view with from=21.");
    expect(r.text).not.toContain("Newer");
  });

  test("around centers on a message and from pages forward", async () => {
    const { view } = setup({ s1: many() });
    const around = await view({ sessionId: "s1", around: 10, limit: 5 });
    expect(around.text).toContain("Showing messages 8-12 of 30.");
    const from = await view({ sessionId: "s1", from: 3, limit: 4 });
    expect(from.text).toContain("Showing messages 3-6 of 30.");
    expect(from.text).toContain("Newer: session_view with from=7.");
  });

  test("renders parts compactly, omits reasoning, truncates long text", async () => {
    const { view } = setup({
      s1: [
        entry("s1", "user", [text("x".repeat(500))]),
        entry("s1", "assistant", [
          { type: "reasoning", text: "private thoughts" },
          text("done"),
          {
            type: "tool-call",
            callId: "c",
            name: "exec",
            input: { cmd: "ls" },
            status: "done",
            output: "HUGE",
          },
          { type: "file", blobId: "b", name: "shot.png", mime: "image/png" },
        ]),
      ],
    });
    const r = await view({ sessionId: "s1", maxChars: 200 });
    expect(r.text).toContain("[300 more chars]");
    expect(r.text).toContain('[tool exec (done) {"cmd":"ls"}]');
    expect(r.text).toContain("[presented: shot.png (image/png)]");
    expect(r.text).not.toContain("private thoughts");
    expect(r.text).not.toContain("HUGE");
  });

  test("reports unknown sessions and out-of-range windows", async () => {
    const { view } = setup({ s1: many() });
    expect((await view({ sessionId: "nope" })).isError).toBe(true);
    expect((await view({ sessionId: "s1", from: 99 })).text).toContain("No messages in that range.");
  });
});

describe("access", () => {
  test("both tools refuse non-owners and the provider lists nothing for them", async () => {
    const { search, view, provided } = setup({ s1: [entry("s1", "user", [text("secret plans")])] });
    expect((await search({ query: "secret" }, "guest")).isError).toBe(true);
    expect((await view({ sessionId: "s1" }, "trusted")).isError).toBe(true);
    const provider = provided.find((p) => p.scope === "tools")?.impl as {
      list(s: { sessionId: string; projectId: string; role: string; caller: unknown }): unknown[];
    };
    expect(provider.list({ sessionId: "s1", projectId: "p1", role: "guest", caller: caller() })).toEqual([]);
  });
});
