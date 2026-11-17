import type { PluginContext } from "@valethq/sdk";
import { DEFAULT_CAP } from "./persona";

/** Fraction of the context window that triggers history trimming and compaction. */
export function compactionThreshold(ctx: PluginContext): number {
  const v = ctx.storage.kv.get<number>("compactionThreshold");
  return typeof v === "number" && v > 0 && v <= 1 ? v : 0.8;
}

/** Default per-file byte cap for persona files; project settings still win. */
export function personaCap(ctx: PluginContext): number {
  const v = ctx.storage.kv.get<number>("personaMaxBytesPerFile");
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : DEFAULT_CAP;
}

/** Names a session with the provider's Utility model after its first completed run. On by default. */
export function autoNameSessions(ctx: PluginContext): boolean {
  const v = ctx.storage.kv.get<boolean>("autoNameSessions");
  return typeof v === "boolean" ? v : true;
}

/** Whether the preamble lists skills and skill_read is offered. On by default; a project can still opt out. */
export function skillsEnabled(ctx: PluginContext): boolean {
  const v = ctx.storage.kv.get<boolean>("skillsEnabled");
  return typeof v === "boolean" ? v : true;
}

export function registerSettings(ctx: PluginContext): void {
  ctx.scopes.define({ name: "settings", version: 1, cardinality: "many" });
  ctx.scopes.provide(
    "settings",
    {
      title: "Context",
      description: "Defaults for context building; project settings still override the persona cap.",
      schema: {
        type: "object",
        properties: {
          compactionThreshold: {
            type: "number",
            title: "Compaction threshold",
            description:
              "Fraction of the model's context window (0-1) that triggers trimming and compaction.",
          },
          personaMaxBytesPerFile: {
            type: "integer",
            title: "Persona byte cap",
            description: "Max bytes read per persona file when the project doesn't set maxBytesPerFile.",
          },
          autoNameSessions: {
            type: "boolean",
            title: "Name sessions automatically",
            description:
              "After a session's first reply, title it with the provider's Utility model (set in the provider's own panel).",
          },
          skillsEnabled: {
            type: "boolean",
            title: "Skills",
            description:
              "List skills (<workspace>/skills and ~/.valet/skills, SKILL.md files) in the preamble and offer skill_read. A project's settings.skills can turn them off or change the folders.",
          },
        },
      },
      get: () => ({
        compactionThreshold: compactionThreshold(ctx),
        personaMaxBytesPerFile: personaCap(ctx),
        autoNameSessions: autoNameSessions(ctx),
        skillsEnabled: skillsEnabled(ctx),
      }),
      set: (v) => {
        const t = v.compactionThreshold;
        if (typeof t !== "number" || !(t > 0) || t > 1)
          throw new Error("compactionThreshold must be a number in (0, 1]");
        const cap = v.personaMaxBytesPerFile;
        if (typeof cap !== "number" || !Number.isInteger(cap) || cap <= 0)
          throw new Error("personaMaxBytesPerFile must be a positive integer");
        if (v.autoNameSessions !== undefined && typeof v.autoNameSessions !== "boolean")
          throw new Error("autoNameSessions must be a boolean");
        if (v.skillsEnabled !== undefined && typeof v.skillsEnabled !== "boolean")
          throw new Error("skillsEnabled must be a boolean");
        if (typeof v.skillsEnabled === "boolean") ctx.storage.kv.set("skillsEnabled", v.skillsEnabled);
        if (typeof v.autoNameSessions === "boolean")
          ctx.storage.kv.set("autoNameSessions", v.autoNameSessions);
        ctx.storage.kv.set("compactionThreshold", t);
        ctx.storage.kv.set("personaMaxBytesPerFile", cap);
      },
    },
    { key: "valet-contextmanager" },
  );
}
