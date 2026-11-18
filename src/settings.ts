import type { PluginContext } from "@valethq/sdk";
import { DEFAULT_CAP } from "./persona";

/** Plugin config (manifest configSchema). Core fills defaults; fallbacks cover tests without a schema layer. */
export interface ContextConfig {
  compactionThreshold?: number;
  personaMaxBytesPerFile?: number;
  autoNameSessions?: boolean;
  skillsEnabled?: boolean;
}

function cfg(ctx: PluginContext): ContextConfig {
  return (ctx.config ?? {}) as ContextConfig;
}

/** Fraction of the context window that triggers history trimming and compaction. */
export function compactionThreshold(ctx: PluginContext): number {
  const v = cfg(ctx).compactionThreshold;
  return typeof v === "number" && v > 0 && v <= 1 ? v : 0.8;
}

/** Default per-file byte cap for persona files; project settings still win. */
export function personaCap(ctx: PluginContext): number {
  const v = cfg(ctx).personaMaxBytesPerFile;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : DEFAULT_CAP;
}

/** Names a session with the provider's Utility model after its first completed run. On by default. */
export function autoNameSessions(ctx: PluginContext): boolean {
  const v = cfg(ctx).autoNameSessions;
  return typeof v === "boolean" ? v : true;
}

/** Whether the preamble lists skills and skill_read is offered. On by default; a project can still opt out. */
export function skillsEnabled(ctx: PluginContext): boolean {
  const v = cfg(ctx).skillsEnabled;
  return typeof v === "boolean" ? v : true;
}
