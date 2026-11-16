import type { PluginContext, ToolCall, ToolDefinition, ToolResult } from "@valethq/sdk";
import type { SearchIndex } from "./searchIndex";
import { viewSession } from "./sessionView";

const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const OWNER_ONLY = "This tool is only available to the owner.";

function intIn(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : fallback;
}
const optInt = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : undefined);
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

interface SearchInput {
  query: string;
  limit?: number;
  sessionId?: string;
  projectId?: string;
}

export function sessionSearchTool(ctx: PluginContext, index: SearchIndex): ToolDefinition<SearchInput> {
  return {
    name: "session_search",
    description:
      "Full-text search across the owner's past chat sessions (every project): messages, compaction summaries and attached file names. Use it to find an earlier conversation, decision or command before continuing the work. Results are ranked and show the session id and message number; open one with session_view.",
    minRole: "owner",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "Words to look for. All must match; if none do, any word may match.",
        },
        limit: { type: "number", description: "Maximum hits, 1-30 (default 10)." },
        sessionId: { type: "string", description: "Only search inside this session." },
        projectId: { type: "string", description: "Only search sessions of this project." },
      },
    },
    async invoke(input, call: ToolCall) {
      if (call.role !== "owner") return fail(OWNER_ONLY);
      if (typeof input?.query !== "string" || !input.query.trim())
        return fail("session_search needs a query.");
      await index.ready;
      const hits = index.search({
        query: input.query,
        limit: intIn(input.limit, 10, 1, 30),
        sessionId: typeof input.sessionId === "string" ? input.sessionId : undefined,
        projectId: typeof input.projectId === "string" ? input.projectId : undefined,
      });
      if (hits.length === 0) return ok(`No sessions match "${input.query}".`);
      const lines = hits.map((h, i) => {
        const title = ctx.store.sessions.get(h.sessionId)?.title ?? "untitled";
        const snippet = h.snippet.replace(/\s+/g, " ");
        return `${i + 1}. ${h.sessionId} "${title}" - message ${h.seq}, ${h.role}, ${stamp(h.createdAt)}Z\n   ${snippet}`;
      });
      return ok(
        `${hits.length} match${hits.length === 1 ? "" : "es"} for "${input.query}":\n\n${lines.join("\n")}\n\nOpen one with session_view (sessionId, around=<message>).`,
      );
    },
  };
}

interface ViewInput {
  sessionId: string;
  around?: number;
  from?: number;
  limit?: number;
  maxChars?: number;
}

export function sessionViewTool(ctx: PluginContext): ToolDefinition<ViewInput> {
  return {
    name: "session_view",
    description:
      "Read messages from one of the owner's chat sessions, including ones from other projects. By default it shows the latest messages. Use `around` to center on a message number from session_search, or `from` to page forward. Reasoning and tool output are left out; tool calls show as one-line stubs.",
    minRole: "owner",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string", description: "Session id, e.g. ses_..." },
        around: { type: "number", description: "Center the window on this message number." },
        from: { type: "number", description: "Start the window at this message number." },
        limit: { type: "number", description: "Messages to show, 1-100 (default 20)." },
        maxChars: {
          type: "number",
          description: "Cut each message at this many characters, 200-50000 (default 3000).",
        },
      },
    },
    async invoke(input, call: ToolCall) {
      if (call.role !== "owner") return fail(OWNER_ONLY);
      if (typeof input?.sessionId !== "string" || !input.sessionId)
        return fail("session_view needs a sessionId.");
      const session = ctx.store.sessions.get(input.sessionId);
      if (!session) return fail(`No such session: ${input.sessionId}`);
      return ok(
        viewSession(ctx, session, {
          sessionId: session.id,
          around: optInt(input.around),
          from: optInt(input.from),
          limit: intIn(input.limit, 20, 1, 100),
          maxChars: intIn(input.maxChars, 3000, 200, 50_000),
        }),
      );
    },
  };
}
