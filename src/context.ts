import type {
  ContextManager,
  ModelMessage,
  PartData,
  PartWriter,
  PersonaFile,
  PluginContext,
  Role,
} from "@valethq/sdk";
import { can, sessionResource } from "@valethq/sdk";
import { historyBudget, latestValetSummary, modelHistory, transcript, trimHistory } from "./history";
import { loadPersonaFiles } from "./persona";
import { loadSkills } from "./skillLoad";
import { renderSkills } from "./skills";
import { compactionThreshold, personaCap } from "./settings";

const AGENTS_RULE_NOTE =
  "(Devin CLI also loads this file as an always-on rule cut at 16 KB; this full copy supersedes it.)";

function renderPreamble(
  files: PersonaFile[],
  skills: string,
  model?: { id: string; contextWindow?: number },
): string {
  const sections = [
    "# Persona",
    ...files.map((f) =>
      f.path === "AGENTS.md"
        ? `## ${f.path}\n\n${AGENTS_RULE_NOTE}\n\n${f.content}`
        : `## ${f.path}\n\n${f.content}`,
    ),
  ];
  if (skills !== "") sections.push(skills);
  const cw = model?.contextWindow;
  if (model && typeof cw === "number" && Number.isFinite(cw) && cw > 0) {
    sections.push(`Context window: ${cw} tokens (model ${model.id}).`);
  }
  return sections.join("\n\n");
}

const SUMMARY_HEAD = "[valet: summary of the earlier part of this chat, compacted by valet]";

// Telling the model to call skill_read when its caller cannot pass the permission
// advertises a tool that is not in its set. preamble() has no run to check, so it
// keeps role-based listing; spec-gap: the context@1 preamble signature carries no caller.
function mayReadSkills(ctx: PluginContext, sessionId: string, runId: string): boolean {
  try {
    return can(
      ctx,
      ctx.store.runs.caller(runId),
      "contextmanager:skill.read",
      sessionResource(ctx, sessionId),
    ).allow;
  } catch {
    return true;
  }
}

interface OpenCompaction {
  writer: PartWriter;
  messageId: string;
  by: string;
  coversThroughSeq: number;
}

export function createContextManager(ctx: PluginContext): ContextManager {
  const open = new Map<string, OpenCompaction>();

  async function start(sessionId: string, by: string): Promise<string> {
    const entries = ctx.store.messages.list(sessionId);
    const coversThroughSeq = entries.at(-1)?.message.seq ?? 0;
    const res = await ctx.store.messages.create({
      sessionId,
      role: "system",
      origin: { platform: "system", conversationId: sessionId },
      status: "streaming",
      parts: [],
    });
    if ("cancelled" in res) throw new Error(res.cancelReason ?? "compaction was cancelled");
    const messageId = res.message.id;
    const writer = ctx.store.messages.openPart(messageId, {
      type: "compaction",
      by,
      status: "in_progress",
      coversThroughSeq,
    });
    open.set(writer.partId, { writer, messageId, by, coversThroughSeq });
    return writer.partId;
  }

  async function end(
    compactionId: string,
    result: { status: "completed" | "failed" | "cancelled"; summary?: string; error?: string },
  ): Promise<void> {
    const o = open.get(compactionId);
    if (!o) throw new Error(`valet-contextmanager: no open compaction "${compactionId}"`);
    open.delete(compactionId);
    const data: PartData = {
      type: "compaction",
      by: o.by,
      status: result.status,
      coversThroughSeq: o.coversThroughSeq,
      ...(result.status === "completed" && result.summary !== undefined ? { summary: result.summary } : {}),
      ...(result.error === undefined ? {} : { error: result.error }),
    };
    o.writer.close(
      result.status === "completed" ? "complete" : result.status === "failed" ? "error" : "interrupted",
      data,
    );
    await ctx.store.messages.complete(o.messageId, "complete");
  }

  async function loadFiles(sessionId: string, role: Role): Promise<PersonaFile[]> {
    const session = ctx.store.sessions.get(sessionId);
    if (!session) throw new Error(`valet-contextmanager: unknown session "${sessionId}"`);
    const project = ctx.store.projects.get(session.projectId);
    if (!project) throw new Error(`valet-contextmanager: unknown project "${session.projectId}"`);
    return loadPersonaFiles(
      project.workspaceDir,
      project.settings,
      role,
      ctx.log,
      personaCap(ctx, project.id),
    );
  }

  return {
    async preamble({ sessionId, role, model }) {
      return renderPreamble(
        await loadFiles(sessionId, role),
        renderSkills(await loadSkills(ctx, sessionId, role)),
        model,
      );
    },

    async build({ sessionId, runId, model, role }) {
      const files = await loadFiles(sessionId, role);
      const skills = mayReadSkills(ctx, sessionId, runId)
        ? renderSkills(await loadSkills(ctx, sessionId, role))
        : "";
      const system = renderPreamble(files, skills, model);
      const entries = ctx.store.messages.list(sessionId);
      const cut = latestValetSummary(entries);
      const messages: ModelMessage[] = [];
      const chars: number[] = [];
      if (cut) {
        const text = `${SUMMARY_HEAD}\n${cut.summary}`;
        messages.push({ role: "user" as const, content: [{ type: "text" as const, text }] });
        chars.push(text.length);
      }
      const history = modelHistory(entries, { runId, images: model.input.includes("image"), cut });
      messages.push(...history.messages);
      chars.push(...history.chars);
      const total = trimHistory(messages, chars, system.length, historyBudget(model), cut ? 1 : 0);
      return { system, messages, estimatedTokens: Math.ceil(total / 4), files };
    },

    async shouldCompact({ model, lastUsage }) {
      if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) return false;
      return (
        (lastUsage.contextTokens ?? lastUsage.inputTokens ?? 0) >
        compactionThreshold(ctx) * model.contextWindow
      );
    },

    async compactionStart({ sessionId, by }) {
      return { compactionId: await start(sessionId, by) };
    },

    async compactionEnd({ compactionId, status, summary, error }) {
      await end(compactionId, { status, summary, error });
    },

    async compact({ sessionId, summarize }) {
      const entries = ctx.store.messages.list(sessionId);
      const text = transcript(entries, latestValetSummary(entries));
      if (text === "") throw new Error("nothing to compact yet");
      const compactionId = await start(sessionId, "valet");
      try {
        const summary = (await summarize(text)).trim();
        if (summary === "") throw new Error("compaction summary was empty");
        await end(compactionId, { status: "completed", summary });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await end(compactionId, { status: "failed", error: message });
        throw error;
      }
    },
  };
}
