import type { PluginContext } from "@valethq/sdk";
import { DEFAULT_CAP } from "./persona";

export interface SettingsPanel {
  title: string;
  description?: string;
  schema: Record<string, unknown>;
  get(): Record<string, unknown> | Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): void | Promise<void>;
}

declare module "@valethq/sdk" {
  interface ValetScopes {
    settings: SettingsPanel;
  }
}

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
        },
      },
      get: () => ({
        compactionThreshold: compactionThreshold(ctx),
        personaMaxBytesPerFile: personaCap(ctx),
      }),
      set: (v) => {
        const t = v.compactionThreshold;
        if (typeof t !== "number" || !(t > 0) || t > 1)
          throw new Error("compactionThreshold must be a number in (0, 1]");
        const cap = v.personaMaxBytesPerFile;
        if (typeof cap !== "number" || !Number.isInteger(cap) || cap <= 0)
          throw new Error("personaMaxBytesPerFile must be a positive integer");
        ctx.storage.kv.set("compactionThreshold", t);
        ctx.storage.kv.set("personaMaxBytesPerFile", cap);
      },
    },
    { key: "valet-contextmanager" },
  );
}
