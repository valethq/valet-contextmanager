import type { Message, ModelContent, ModelMessage, Part, PartData } from "@valethq/sdk";

export interface Entry {
  message: Message;
  parts: Part[];
}

export interface SummaryCut {
  summary: string;
  coversThroughSeq: number;
}

type ToolCallData = Extract<PartData, { type: "tool-call" }>;

// spec-gap: only image file parts have a ModelContent form; other files stay a text note.
export function fileNote(message: Message, file: Extract<PartData, { type: "file" }>): string {
  const verb = message.role === "assistant" ? "presented to the user" : "attached";
  return `[${verb}: ${file.name} (${file.mime})]`;
}

// spec-gap: compaction transcripts clip tool output; the doc sets no limit.
const TOOL_OUTPUT_CLIP = 2_000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}... [${text.length - max} more chars]`;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

// spec-gap: a pending or running tool call is replayed as "interrupted" so the call still has a result.
function toolContent(data: ToolCallData): ModelContent[] {
  if (data.status === "pending" || data.status === "running") return [{ type: "text", text: "interrupted" }];
  if (data.result?.content) return data.result.content;
  return [{ type: "text", text: data.output ?? "" }];
}

function toolIsError(data: ToolCallData): boolean {
  return data.status === "error" || data.status === "denied" || data.status === "cancelled";
}

function toolMessage(data: ToolCallData): ModelMessage {
  const content = toolContent(data);
  return toolIsError(data)
    ? { role: "tool", callId: data.callId, content, isError: true }
    : { role: "tool", callId: data.callId, content };
}

function renderTool(data: ToolCallData): string {
  const output = clip(contentText(toolContent(data)), TOOL_OUTPUT_CLIP);
  return `[tool ${data.name} input=${jsonText(data.input)} output=${output}]`;
}

function contentText(content: ModelContent[]): string {
  const bits: string[] = [];
  for (const c of content) {
    if (c.type === "text") bits.push(c.text);
    else if (c.type === "image") bits.push(`[image ${c.mime}]`);
  }
  return bits.join("\n");
}

function partLine(message: Message, data: PartData): string | undefined {
  switch (data.type) {
    case "text":
    case "custom":
      return data.text;
    case "file":
      return fileNote(message, data);
    case "tool-call":
      return renderTool(data);
    default:
      return undefined;
  }
}

/** Text of every message after `since` (seq), prefixed by the prior summary so the new one folds it in. */
export function transcript(entries: Entry[], since: SummaryCut | undefined): string {
  const lines: string[] = [];
  for (const { message, parts } of entries) {
    if (since !== undefined && message.seq <= since.coversThroughSeq) continue;
    const body = parts.flatMap((p) => {
      const line = partLine(message, p.data);
      return line === undefined ? [] : [line];
    });
    if (body.length > 0) lines.push(`${message.role}: ${body.join("\n")}`);
  }
  const prior = since === undefined ? [] : [`Earlier summary:\n${since.summary}`];
  return [...prior, ...lines].join("\n\n");
}

/** The latest completed valet summary. Harness markers and blank, failed, or open compactions do not cut history. */
export function latestValetSummary(entries: Entry[]): SummaryCut | undefined {
  let found: SummaryCut | undefined;
  for (const { parts } of entries) {
    for (const { data } of parts) {
      if (data.type !== "compaction" || data.by !== "valet" || data.status !== "completed") continue;
      const summary = data.summary?.trim() ?? "";
      if (summary === "") continue;
      found = { summary, coversThroughSeq: data.coversThroughSeq };
    }
  }
  return found;
}

function block(message: Message, data: PartData, images: boolean): ModelContent[] {
  switch (data.type) {
    case "text":
    case "custom":
      return [{ type: "text", text: data.text }];
    case "file":
      if (images && data.mime.startsWith("image/"))
        return [{ type: "image", mime: data.mime, blobId: data.blobId }];
      return [{ type: "text", text: fileNote(message, data) }];
    default:
      return [];
  }
}

function storedMessage(message: Message, content: ModelContent[]): ModelMessage {
  if (message.role === "tool") {
    const callId = typeof message.meta.callId === "string" ? message.meta.callId : message.id;
    return { role: "tool", callId, content };
  }
  // stored "system" messages have no ModelMessage role; they ride as user text
  return { role: "user", content };
}

function messageModels(message: Message, parts: Part[], images: boolean): ModelMessage[] {
  if (message.role === "assistant") return assistantMessages(message, parts, images);
  const content = parts.flatMap((p) => block(message, p.data, images));
  return content.length === 0 ? [] : [storedMessage(message, content)];
}

function assistantMessages(message: Message, parts: Part[], images: boolean): ModelMessage[] {
  const out: ModelMessage[] = [];
  let seg: ModelContent[] = [];
  let calls: ToolCallData[] = [];
  const flush = () => {
    if (seg.length === 0) return;
    out.push({ role: "assistant", content: seg });
    for (const call of calls) out.push(toolMessage(call));
    seg = [];
    calls = [];
  };
  for (const { data } of parts) {
    if (data.type === "tool-call") {
      seg.push({ type: "tool-call", callId: data.callId, name: data.name, input: data.input });
      calls.push(data);
      continue;
    }
    const next = block(message, data, images);
    if (next.length === 0) continue;
    if (calls.length > 0) flush();
    seg.push(...next);
  }
  flush();
  return out;
}

export function modelHistory(
  entries: Entry[],
  opts: { runId: string; images: boolean; cut?: SummaryCut },
): { messages: ModelMessage[]; chars: number[] } {
  const messages: ModelMessage[] = [];
  const chars: number[] = [];
  for (const { message, parts } of entries) {
    if (message.role === "assistant" && message.runId === opts.runId) continue;
    if (opts.cut && message.seq <= opts.cut.coversThroughSeq) continue;
    for (const m of messageModels(message, parts, opts.images)) {
      messages.push(m);
      chars.push(contentChars(m.content));
    }
  }
  return { messages, chars };
}

function contentChars(content: ModelContent[]): number {
  let n = 0;
  for (const c of content) {
    if (c.type === "text") n += c.text.length;
    else if (c.type === "tool-call") n += c.name.length + jsonText(c.input).length;
  }
  return n;
}

export function historyBudget(model: {
  contextWindow: number;
  maxOutputTokens?: number;
}): number | undefined {
  if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) return undefined;
  // spec-gap: reserve is clamped to a quarter of the window so a large maxOutputTokens cannot erase history.
  const maxOut = model.maxOutputTokens;
  const raw = typeof maxOut === "number" && Number.isFinite(maxOut) && maxOut > 0 ? maxOut : 0;
  return model.contextWindow - Math.min(raw, Math.floor(model.contextWindow / 4));
}

function groupEnd(messages: ModelMessage[], start: number): number {
  const head = messages[start];
  if (head?.role !== "assistant") return start + 1;
  const pending = head.content.flatMap((c) => (c.type === "tool-call" ? [c.callId] : []));
  if (pending.length === 0) return start + 1;
  let end = start + 1;
  while (end < messages.length) {
    const next = messages[end];
    if (next?.role !== "tool") break;
    const at = pending.indexOf(next.callId);
    if (at < 0) break;
    pending.splice(at, 1);
    end += 1;
  }
  return end;
}

function remove(messages: ModelMessage[], chars: number[], start: number, end: number): number {
  let n = 0;
  for (let i = start; i < end; i++) n += chars[i] ?? 0;
  messages.splice(start, end - start);
  chars.splice(start, end - start);
  return n;
}

/** Drops the oldest history until it fits. Keeps the summary and the latest user turn, tool pairs included. */
export function trimHistory(
  messages: ModelMessage[],
  chars: number[],
  systemChars: number,
  budget: number | undefined,
  summaryCount: number,
): number {
  let total = systemChars;
  for (const n of chars) total += n;
  if (budget === undefined) return total;

  const over = () => Math.ceil(total / 4) > budget;
  let latestUser = -1;
  for (let i = summaryCount; i < messages.length; i++) {
    if (messages[i]?.role === "user") latestUser = i;
  }

  let trimmed = false;
  for (;;) {
    const start = summaryCount;
    if (start >= messages.length) break;
    const head = messages[start];
    if (!head) break;
    if (!over() && !(trimmed && head.role !== "user")) break;

    const end = groupEnd(messages, start);
    if (latestUser !== -1 && (start >= latestUser || end > latestUser)) break;
    if (latestUser === -1 && summaryCount === 0 && end >= messages.length) break;
    if (end <= start) break;

    total -= remove(messages, chars, start, end);
    if (latestUser !== -1) latestUser -= end - start;
    trimmed = true;
  }
  return total;
}
