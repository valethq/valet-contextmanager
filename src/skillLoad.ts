import type { PluginContext, Role } from "@valethq/sdk";
import { type Skill, discoverSkills, skillRoots, visibleTo } from "./skills";
import { skillsEnabled } from "./settings";

/** Skills the session's project exposes to this role; empty when skills are off or the session is unknown. */
export async function loadSkills(ctx: PluginContext, sessionId: string, role: Role): Promise<Skill[]> {
  const session = ctx.store.sessions.get(sessionId);
  const project = session && ctx.store.projects.get(session.projectId);
  if (!project || !skillsEnabled(ctx, project.id)) return [];
  const roots = skillRoots(project.workspaceDir, project.settings, ctx.paths.valetHome);
  return roots === null ? [] : visibleTo(await discoverSkills(roots, ctx.log), role);
}
