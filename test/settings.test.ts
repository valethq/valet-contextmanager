import { afterAll, expect, test } from "bun:test";
import { boot, cleanup, entry, model, project, session, text, workspace } from "./helpers";
import type { SettingsPanel } from "../src/settings";

afterAll(cleanup);

const panel = (b: ReturnType<typeof boot>) =>
  b.provided.find((p) => p.scope === "settings")?.impl as SettingsPanel;

test("settings panel registers on the settings scope", () => {
  const b = boot();
  expect(b.provided.map((p) => p.scope)).toEqual(["context", "settings"]);
  expect(panel(b).title).toBe("Context");
});

test("compactionThreshold drives shouldCompact", async () => {
  const b = boot();
  const req = { sessionId: "s1", model: model(1000), lastUsage: { inputTokens: 810 } };
  expect(await b.impl.shouldCompact(req)).toBe(true);
  b.kv.set("compactionThreshold", 0.9);
  expect(await b.impl.shouldCompact(req)).toBe(false);
});

test("compactionThreshold drives build trimming", async () => {
  const dir = await workspace({ "AGENTS.md": "rules" });
  const messages = [1, 2, 3].map((_i) => entry("s1", "user", [text("x".repeat(100))]));
  const b = boot({
    sessions: [session("s1", "p1")],
    projects: [project("p1", dir)],
    messages: { s1: messages },
  });
  // ~105+300 chars -> ~101 tokens; threshold 0.5 of 1000 keeps everything,
  // threshold 0.08 trims old messages.
  b.kv.set("compactionThreshold", 0.5);
  const wide = await b.impl.build({ sessionId: "s1", runId: "r", model: model(1000), role: "owner" });
  expect(wide.messages).toHaveLength(3);
  b.kv.set("compactionThreshold", 0.08);
  const narrow = await b.impl.build({ sessionId: "s1", runId: "r", model: model(1000), role: "owner" });
  expect(narrow.messages.length).toBeLessThan(3);
});

test("personaMaxBytesPerFile caps default persona files", async () => {
  const dir = await workspace({ "AGENTS.md": "y".repeat(200) });
  const b = boot({
    sessions: [session("s1", "p1")],
    projects: [project("p1", dir)],
  });
  b.kv.set("personaMaxBytesPerFile", 100);
  const out = await b.impl.preamble({ sessionId: "s1", role: "owner", model: model(1000) });
  expect(out).toContain("truncated 100 bytes");
});

test("panel set validates and persists", async () => {
  const b = boot();
  const p = panel(b);
  expect(await p.get()).toEqual({
    compactionThreshold: 0.8,
    personaMaxBytesPerFile: 65536,
    autoNameSessions: true,
  });
  await p.set({ compactionThreshold: 0.5, personaMaxBytesPerFile: 1024 });
  expect(b.kv.get("compactionThreshold")).toBe(0.5);
  expect(b.kv.get("personaMaxBytesPerFile")).toBe(1024);
  expect(() => p.set({ compactionThreshold: 2, personaMaxBytesPerFile: 1024 })).toThrow(
    "compactionThreshold",
  );
  expect(() => p.set({ compactionThreshold: 0.5, personaMaxBytesPerFile: 1.5 })).toThrow(
    "personaMaxBytesPerFile",
  );
});
