import { expect, test } from "bun:test";
import type { Run, UtilityModel } from "@valethq/sdk";
import { cleanTitle, isPlaceholder } from "../src/naming";
import { boot, entry, project, session, text } from "./helpers";

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1",
  sessionId: "s1",
  triggerMessageId: null,
  status: "complete",
  role: "owner",
  provider: "devin-cli",
  model: "m",
  startedAt: 0,
  endedAt: 0,
  error: null,
  usage: {},
  ...over,
});

function utility(reply: string | Error = "Fixing Caddy Restart Loop") {
  const calls: { system: string; prompt: string }[] = [];
  const u: UtilityModel = {
    model: () => "haiku",
    complete: async (req) => {
      calls.push(req);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { u, calls };
}

/** `placeholder` is the first-message title recorded in the session settings; null means a person set the title. */
function chat(
  title: string | null,
  placeholder: string | null = null,
  first = "caddy keeps restarting after my config change",
) {
  const base = session("s1", "p1");
  const s = { ...base, title, settings: placeholder === null ? {} : { titlePlaceholder: placeholder } };
  return {
    sessions: [s],
    projects: [project("p1", "/tmp")],
    messages: {
      s1: [entry("s1", "user", [text(first)]), entry("s1", "assistant", [text("Check the logs.")])],
    },
  };
}

test("cleanTitle strips decoration and caps length", () => {
  expect(cleanTitle('"Fixing Caddy."')).toBe("Fixing Caddy");
  expect(cleanTitle("Title: **Docker Restart Loop**\nBecause...")).toBe("Docker Restart Loop");
  expect(cleanTitle("  \n ")).toBeNull();
  expect(cleanTitle("word ".repeat(30))?.length).toBeLessThanOrEqual(60);
});

test("isPlaceholder is true for no title or the recorded placeholder, never for a person's title", () => {
  const s = session("s1", "p1");
  expect(isPlaceholder(s)).toBe(true);
  expect(isPlaceholder({ ...s, title: "caddy keeps", settings: { titlePlaceholder: "caddy keeps" } })).toBe(
    true,
  );
  expect(isPlaceholder({ ...s, title: "Homelab work", settings: { titlePlaceholder: "caddy keeps" } })).toBe(
    false,
  );
  expect(isPlaceholder({ ...s, title: "Homelab work" })).toBe(false);
});

test("titles an empty session from the first usable user message", async () => {
  const s = { ...session("s1", "p1"), settings: { persona: "p" } };
  const b = boot({ sessions: [s], config: { autoNameSessions: false } });
  await b.fire("session.create", { session: s });
  await b.fire("message.create", entry("s1", "system", [text("system notice")]));
  await b.fire("message.create", entry("s1", "user", [text("/model fake:m")]));
  await b.fire("message.create", entry("s1", "user", [text("draft")], { status: "streaming" }));
  expect(b.session("s1")?.title).toBeNull();

  await b.fire("message.create", entry("s1", "user", [text("## Please summarize this document")]));
  await b.fire("message.create", entry("s1", "user", [text("Now something completely different")]));
  expect(b.titles).toEqual([{ id: "s1", title: "Please summarize this document" }]);
  expect(b.session("s1")?.settings).toEqual({
    persona: "p",
    titlePlaceholder: "Please summarize this document",
  });
});

test("preserves a title supplied at session creation", async () => {
  const s = { ...session("s1", "p1"), title: "My notes" };
  const b = boot({ sessions: [s] });
  await b.fire("message.create", entry("s1", "user", [text("Please summarize this document")]));
  expect(b.session("s1")?.title).toBe("My notes");
  expect(b.titles).toEqual([]);
});

test("backfills an untitled session from its oldest user message at startup", async () => {
  const s = session("s1", "p1");
  const b = boot({
    sessions: [s],
    messages: {
      s1: Array.from({ length: 25 }, (_, i) =>
        entry("s1", i % 2 === 0 ? "user" : "assistant", [text(`line ${i + 1}`)]),
      ),
    },
  });
  await b.fire("core.ready", {});
  expect(b.titles).toEqual([{ id: "s1", title: "line 1" }]);
});

test("names a session with the run provider's Utility model after its first run", async () => {
  const { u, calls } = utility();
  const b = boot({
    ...chat("caddy keeps restarting after my config change", "caddy keeps restarting after my config change"),
    inference: { "devin-cli": { utility: u } },
  });
  await b.fire("run.end", { run: run() });
  expect(b.titles).toEqual([{ id: "s1", title: "Fixing Caddy Restart Loop" }]);
  expect(b.session("s1")?.settings.titlePlaceholder).toBeUndefined();
  expect(calls[0]?.prompt).toContain("User: caddy keeps restarting");
  expect(calls[0]?.prompt).toContain("Assistant: Check the logs.");
  await b.fire("run.end", { run: run() });
  expect(calls).toHaveLength(1);
});

test("never overwrites a title a person chose", async () => {
  const { u, calls } = utility();
  const b = boot({ ...chat("My homelab notes"), inference: { "devin-cli": { utility: u } } });
  await b.fire("run.end", { run: run() });
  expect(calls).toHaveLength(0);
  expect(b.titles).toEqual([]);
});

test("a title a person set over the placeholder is kept", async () => {
  const { u, calls } = utility();
  const b = boot({
    ...chat("My homelab notes", "caddy keeps restarting"),
    inference: { "devin-cli": { utility: u } },
  });
  await b.fire("run.end", { run: run() });
  expect(calls).toHaveLength(0);
  expect(b.titles).toEqual([]);
  expect(b.session("s1")?.title).toBe("My homelab notes");
});

test("skips failed runs, providers without a Utility model, and the off switch", async () => {
  const { u, calls } = utility();
  const b = boot({ ...chat(null), inference: { "devin-cli": { utility: u }, plain: {} } });
  await b.fire("run.end", { run: run({ status: "error" }) });
  await b.fire("run.end", { run: run({ provider: "plain" }) });
  await b.fire("run.end", { run: run({ provider: "missing" }) });
  b.setConfig({ autoNameSessions: false });
  await b.fire("run.end", { run: run() });
  expect(calls).toHaveLength(0);
});

test("a failing Utility model leaves the title alone and gives up after three tries", async () => {
  const { u, calls } = utility(new Error("boom"));
  const b = boot({ ...chat(null), inference: { "devin-cli": { utility: u } } });
  for (let i = 0; i < 5; i++) await b.fire("run.end", { run: run() });
  expect(calls).toHaveLength(3);
  expect(b.titles).toEqual([]);
  expect(b.warns.filter((w) => w.msg === "session naming failed")).toHaveLength(3);
});
