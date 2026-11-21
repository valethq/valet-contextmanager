import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginContext, Setting } from "@valethq/sdk";
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
const settings = (manifest.settings.sections.system.subsections as { items: Setting[] }[]).flatMap(
  (s) => s.items,
);
const props = Object.fromEntries(settings.map((s) => [s.id, { default: s.input.default, scopes: s.scopes }]));

function ctxWith(config: ContextConfig): PluginContext<ContextConfig> {
  return { config, configFor: () => config } as unknown as PluginContext<ContextConfig>;
}

describe("settings are config", () => {
  test("manifest declares a settings doc under system and provides no settings scope", () => {
    expect(manifest.provides).toEqual(["context@1", "tools@1"]);
    expect(manifest.settings.sections.system.icon).toBe("layers");
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
    expect(personaCap(ctx)).toBe(64 * 1024);
    expect(props.personaMaxBytesPerFile?.default).toBe("64 KiB");
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

test("build trimming clamps the output reserve and ignores compactionThreshold", async () => {
  const dir = await workspace({ "AGENTS.md": "rules" });
  const messages = [1, 2, 3].map(() => entry("s1", "user", [text("x".repeat(100))]));
  const b = boot({
    sessions: [session("s1", "p1")],
    projects: [project("p1", dir)],
    messages: { s1: messages },
  });
  // model() reserves 4096 tokens. On a 1000 window that clamps to 250, so all three messages fit.
  const m = model(1000);
  b.setConfig({ compactionThreshold: 0.5 });
  const wide = await b.impl.build({ sessionId: "s1", runId: "r", model: m, role: "owner" });
  expect(wide.messages).toHaveLength(3);
  b.setConfig({ compactionThreshold: 0.08 });
  const narrow = await b.impl.build({ sessionId: "s1", runId: "r", model: m, role: "owner" });
  expect(narrow.messages).toEqual(wide.messages);
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

describe("project layer", () => {
  test("persona cap and skills are the only settings a project may override", () => {
    expect(settings.filter((s) => s.scopes?.includes("project")).map((s) => s.id)).toEqual([
      "personaMaxBytesPerFile",
      "skillsEnabled",
    ]);
  });

  test("a project override is read through configFor; the older project.settings keys still win", async () => {
    const big = "y".repeat(200);
    const a = await workspace({ "AGENTS.md": big });
    const b = await workspace({ "AGENTS.md": big });
    const booted = boot({
      sessions: [session("s1", "p1"), session("s2", "p2")],
      projects: [project("p1", a), project("p2", b, { persona: { maxBytesPerFile: 150 } })],
    });
    booted.setProjectConfig("p1", { personaMaxBytesPerFile: 100 });
    booted.setProjectConfig("p2", { personaMaxBytesPerFile: 100 });
    const one = await booted.impl.preamble({ sessionId: "s1", role: "owner", model: model(1000) });
    expect(one).toContain("truncated 100 bytes");
    const two = await booted.impl.preamble({ sessionId: "s2", role: "owner", model: model(1000) });
    expect(two).toContain("truncated 50 bytes");
  });

  test("a project can turn skills off", () => {
    const ctx = {
      config: { skillsEnabled: true },
      configFor: (id: string) => (id === "p1" ? { skillsEnabled: false } : { skillsEnabled: true }),
    } as unknown as PluginContext<ContextConfig>;
    expect(skillsEnabled(ctx, "p1")).toBe(false);
    expect(skillsEnabled(ctx, "p2")).toBe(true);
    expect(skillsEnabled(ctx)).toBe(true);
  });
});
