import type {
  Message,
  ModelContent,
  ModelMessage,
  Part,
  PartData,
  PartWriter,
  PluginContext,
  Role,
} from "@valethq/sdk";
import { loadPersonaFiles } from "./persona";
import { compactionThreshold, personaCap } from "./settings";
import type { ContextManager, PersonaFile } from "./types";

const AGENTS_RULE_NOTE =
  "(Devin CLI also loads this file as an always-on rule cut at 16 KB; this full copy supersedes it.)";

function renderPreamble(files: PersonaFile[], model?: { id: string; contextWindow?: number }): string {
  const sections = [
    "# Persona",
    ...files.map((f) =>
      f.path === "AGENTS.md"
        ? `## ${f.path}\n\n${AGENTS_RULE_NOTE}\n\n${f.content}`
        : `## ${f.path}\n\n${f.content}`,
    ),
  ];
  const cw = model?.contextWindow;
  if (model && typeof cw === "number" && Number.isFinite(cw) && cw > 0) {
    sections.push(`Context window: ${cw} tokens (model ${model.id}).`);
  }
  return sections.join("\n\n");
}

function toModelMessage(message: Message, content: ModelContent[]): ModelMessage {
  switch (message.role) {
    case "assistant":
      return { role: "assistant", content };
    case "tool": {
      const callId = typeof message.meta.callId === "string" ? message.meta.callId : message.id;
      return { role: "tool", callId, content };
    }
    default:
      // stored "system" messages have no ModelMessage role; they ride as user text
      return { role: "user", content };
  }
}

const SUMMARY_HEAD = "[valet: summary of the earlier part of this chat, compacted by valet]";

interface Entry {
  message: Message;
  parts: Part[];
}
interface Summary {
  summary: string;
  coversThroughSeq: number;
}

/** The latest completed valet summary; harness markers and failed or open compactions never replace history. */
function latestSummary(entries: Entry[]): Summary | undefined {
  let found: Summary | undefined;
  for (const { parts } of entries)
    for (const { data } of parts)
      if (data.type === "compaction" && data.status === "completed" && data.summary !== undefined)
        found = { summary: data.summary, coversThroughSeq: data.coversThroughSeq };
  return found;
}

interface OpenCompaction {
  writer: PartWriter;
  messageId: string;
  by: string;
  coversThroughSeq: number;
}

/** Text of every message after `since` (seq), prefixed by the prior summary so the new one folds it in. */
function transcript(entries: Entry[], since: Summary | undefined): string {
  const lines: string[] = [];
  for (const { message, parts } of entries) {
    if (since !== undefined && message.seq <= since.coversThroughSeq) continue;
    const texts = parts.flatMap((p) => (p.data.type === "text" ? [p.data.text] : []));
    if (texts.length > 0) lines.push(`${message.role}: ${texts.join("\n")}`);
  }
  const prior = since === undefined ? [] : [`Earlier summary:\n${since.summary}`];
  return [...prior, ...lines].join("\n\n");
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
    return loadPersonaFiles(project.workspaceDir, project.settings, role, ctx.log, personaCap(ctx));
  }

  return {
    async preamble({ sessionId, role, model }) {
      return renderPreamble(await loadFiles(sessionId, role), model);
    },

    async build({ sessionId, runId, model, role }) {
      const files = await loadFiles(sessionId, role);
      const system = renderPreamble(files, model);
      const entries = ctx.store.messages.list(sessionId);
      const cut = latestSummary(entries);
      const messages: ModelMessage[] = [];
      const chars: number[] = [];
      if (cut) {
        const text = `${SUMMARY_HEAD}\n${cut.summary}`;
        messages.push({ role: "user", content: [{ type: "text", text }] });
        chars.push(text.length);
      }
      for (const { message, parts } of entries) {
        if (message.role === "assistant" && message.runId === runId) continue;
        if (cut && message.seq <= cut.coversThroughSeq) continue;
        const texts = parts.flatMap((p) => (p.data.type === "text" ? [p.data.text] : []));
        if (texts.length === 0) continue;
        const content: ModelContent[] = texts.map((t) => ({ type: "text", text: t }));
        messages.push(toModelMessage(message, content));
        chars.push(texts.reduce((n, t) => n + t.length, 0));
      }
      let total = system.length + chars.reduce((a, b) => a + b, 0);
      if (Number.isFinite(model.contextWindow) && model.contextWindow > 0) {
        while (messages.length > 0 && Math.ceil(total / 4) > compactionThreshold(ctx) * model.contextWindow) {
          messages.shift();
          total -= chars.shift() ?? 0;
        }
      }
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
      const text = transcript(entries, latestSummary(entries));
      if (text === "") throw new Error("nothing to compact yet");
      const compactionId = await start(sessionId, "valet");
      try {
        const summary = await summarize(text);
        await end(compactionId, { status: "completed", summary });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await end(compactionId, { status: "failed", error: message });
        throw error;
      }
    },
  };
}
