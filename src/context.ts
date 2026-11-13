import type { Message, ModelContent, ModelMessage, PluginContext, Role } from "@valethq/sdk";
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

export function createContextManager(ctx: PluginContext): ContextManager {
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
      const messages: ModelMessage[] = [];
      const chars: number[] = [];
      for (const { message, parts } of ctx.store.messages.list(sessionId)) {
        if (message.role === "assistant" && message.runId === runId) continue;
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

    async compact() {
      throw new Error("valet-contextmanager: compaction lands in M3");
    },
  };
}
