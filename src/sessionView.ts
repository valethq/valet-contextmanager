import type { Message, Part, PluginContext, Session } from "@valethq/sdk";

const TOTAL_CHARS = 40_000;
const stamp = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}... [${text.length - max} more chars]`;
}

function renderPart(message: Message, part: Part, maxChars: number): string | undefined {
  const { data } = part;
  switch (data.type) {
    case "text":
    case "custom":
      return clip(data.text, maxChars);
    case "tool-call":
      return `[tool ${data.name} (${data.status}) ${clip(JSON.stringify(data.input) ?? "", 200)}]`;
    case "file":
      return `[${message.role === "assistant" ? "presented" : "attached"}: ${data.name} (${data.mime})]`;
    case "notice":
      return `[notice, ${data.level}: ${data.text}]`;
    case "compaction":
      return data.status === "completed" && data.summary
        ? `[compaction summary, covers messages up to ${data.coversThroughSeq}]\n${clip(data.summary, maxChars)}`
        : undefined;
    default:
      return undefined;
  }
}

export function renderMessage(message: Message, parts: Part[], maxChars: number): string | undefined {
  const body = parts.flatMap((p) => renderPart(message, p, maxChars) ?? []).join("\n");
  return body === "" ? undefined : `[${message.seq}] ${message.role} ${stamp(message.createdAt)}\n${body}`;
}

export interface ViewRequest {
  sessionId: string;
  around?: number;
  from?: number;
  limit: number;
  maxChars: number;
}

/** The window of a session's messages the request asks for, rendered as plain text. */
export function viewSession(ctx: PluginContext, session: Session, req: ViewRequest): string {
  const { store } = ctx;
  const latest = store.messages.list(session.id, { limit: 1 })[0]?.message.seq ?? 0;
  const before =
    req.around !== undefined
      ? req.around + Math.floor(req.limit / 2) + 1
      : req.from !== undefined
        ? req.from + req.limit
        : undefined;
  const start = req.around !== undefined ? req.around - Math.ceil(req.limit / 2) + 1 : req.from;
  const window = store.messages
    .list(session.id, { limit: req.limit, ...(before === undefined ? {} : { beforeSeq: before }) })
    .filter((e) => start === undefined || e.message.seq >= start);

  const project = store.projects.get(session.projectId);
  const head = [
    `Session ${session.id} "${session.title ?? "untitled"}"`,
    `project ${project?.name ?? session.projectId}, ${session.status}, created ${stamp(session.createdAt)}, ${latest} messages`,
  ].join(" - ");
  if (window.length === 0) return `${head}\nNo messages in that range.`;

  const blocks: string[] = [];
  let used = 0;
  let last = window[0]?.message.seq ?? 0;
  for (const { message, parts } of window) {
    const block = renderMessage(message, parts, req.maxChars);
    if (block === undefined) {
      last = message.seq;
      continue;
    }
    if (used + block.length > TOTAL_CHARS && blocks.length > 0) break;
    blocks.push(block);
    used += block.length;
    last = message.seq;
  }
  const first = window[0]?.message.seq ?? 0;
  const notes = [`Showing messages ${first}-${last} of ${latest}.`];
  if (first > 1) notes.push(`Older: session_view with from=${Math.max(1, first - req.limit)}.`);
  if (last < latest) notes.push(`Newer: session_view with from=${last + 1}.`);
  return `${head}\n\n${blocks.join("\n\n")}\n\n${notes.join(" ")}`;
}
