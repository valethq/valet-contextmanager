import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginContext } from "@valethq/sdk";
import {
  autoNameSessions,
  type ContextConfig,
  compactionThreshold,
  personaCap,
  skillsEnabled,
} from "../src/settings";
import { boot, cleanup, entry, model, project, session, text, workspace } from "./helpers";

afterAll(cleanup);

const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "manifest.json"), "utf8"));
const props = manifest.configSchema.properties as Record<string, { default?: unknown }>;

function ctxWith(config: ContextConfig): PluginContext<ContextConfig> {
  return { config } as PluginContext<ContextConfig>;
}

describe("settings are config", () => {
  test("manifest declares configSchema and no longer provides settings@1", () => {
    expect(manifest.provides).toEqual(["context@1", "tools@1"]);
    expect(manifest.configSchema["x-group"]).toBe("system");
    expect(Object.keys(props).sort()).toEqual([
      "autoNameSessions",
      "compactionThreshold",
      "personaMaxBytesPerFile",
      "skillsEnabled",
    ]);
  });

  test("accessors fall back to the same defaults the manifest declares", () => {
    const ctx = ctxWith({});
    expect(compactionThreshold(ctx)).toBe(props.compactionThreshold?.default as number);
    expect(personaCap(ctx)).toBe(props.personaMaxBytesPerFile?.default as number);
    expect(autoNameSessions(ctx)).toBe(props.autoNameSessions?.default as boolean);
    expect(skillsEnabled(ctx)).toBe(props.skillsEnabled?.default as boolean);
  });

  test("config values win", () => {
    const ctx = ctxWith({
      compactionThreshold: 0.5,
      personaMaxBytesPerFile: 1024,
      autoNameSessions: false,
      skillsEnabled: false,
    });
    expect(compactionThreshold(ctx)).toBe(0.5);
    expect(personaCap(ctx)).toBe(1024);
    expect(autoNameSessions(ctx)).toBe(false);
    expect(skillsEnabled(ctx)).toBe(false);
  });

  test("activate no longer registers a settings panel", () => {
    const b = boot();
    expect(b.provided.map((p) => p.scope)).toEqual(["context", "tools", "tools"]);
  });
});

test("compactionThreshold drives shouldCompact", async () => {
  const b = boot();
  const req = { sessionId: "s1", model: model(1000), lastUsage: { inputTokens: 810 } };
  expect(await b.impl.shouldCompact(req)).toBe(true);
  b.setConfig({ compactionThreshold: 0.9 });
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
  b.setConfig({ compactionThreshold: 0.5 });
  const wide = await b.impl.build({ sessionId: "s1", runId: "r", model: model(1000), role: "owner" });
  expect(wide.messages).toHaveLength(3);
  b.setConfig({ compactionThreshold: 0.08 });
  const narrow = await b.impl.build({ sessionId: "s1", runId: "r", model: model(1000), role: "owner" });
  expect(narrow.messages.length).toBeLessThan(3);
});

test("personaMaxBytesPerFile caps default persona files", async () => {
  const dir = await workspace({ "AGENTS.md": "y".repeat(200) });
  const b = boot({
    sessions: [session("s1", "p1")],
    projects: [project("p1", dir)],
  });
  b.setConfig({ personaMaxBytesPerFile: 100 });
  const out = await b.impl.preamble({ sessionId: "s1", role: "owner", model: model(1000) });
  expect(out).toContain("truncated 100 bytes");
});
