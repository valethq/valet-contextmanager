import type { PluginContext } from "@valethq/sdk";
import { DEFAULT_CAP } from "./persona";

/** Plugin config (manifest settings doc). Core fills defaults; fallbacks cover tests without a schema layer. */
export interface ContextConfig {
  compactionThreshold?: number;
  personaMaxBytesPerFile?: number;
  autoNameSessions?: boolean;
  skillsEnabled?: boolean;
}

/** The user block, or a project's view of it when the project overrides a setting (12.1 project layer). */
function cfg(ctx: PluginContext, projectId?: string): ContextConfig {
  return ((projectId === undefined ? ctx.config : ctx.configFor(projectId)) ?? {}) as ContextConfig;
}

/** Fraction of the context window that triggers history trimming and compaction. */
export function compactionThreshold(ctx: PluginContext): number {
  const v = cfg(ctx).compactionThreshold;
  return typeof v === "number" && v > 0 && v <= 1 ? v : 0.8;
}

/** Default per-file byte cap for persona files; the older `project.settings.persona.maxBytesPerFile` still wins. */
export function personaCap(ctx: PluginContext, projectId?: string): number {
  const v = cfg(ctx, projectId).personaMaxBytesPerFile;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : DEFAULT_CAP;
}

/** Names a session with the provider's Utility model after its first completed run. On by default. */
export function autoNameSessions(ctx: PluginContext): boolean {
  const v = cfg(ctx).autoNameSessions;
  return typeof v === "boolean" ? v : true;
}

/** Whether the preamble lists skills and skill_read is offered. On by default; `project.settings.skills` still wins. */
export function skillsEnabled(ctx: PluginContext, projectId?: string): boolean {
  const v = cfg(ctx, projectId).skillsEnabled;
  return typeof v === "boolean" ? v : true;
}
