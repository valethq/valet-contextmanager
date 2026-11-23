import type { Part, PluginContext, Session } from "@valethq/sdk";
import { autoNameSessions } from "./settings";
import { placeholderPatch } from "./title";

const SYSTEM =
  "Write a title for this chat in 3 to 6 words, in the language the user wrote in. No quotes, no markdown, no trailing punctuation. Reply with the title only.";
const MAX_TITLE = 60;
const MAX_SNIPPET = 1500;
const MAX_FAILURES = 3;
const TIMEOUT_MS = 30_000;

const textOf = (parts: Part[]): string =>
  parts.flatMap((p) => (p.data.type === "text" ? [p.data.text] : [])).join("\n");

/** Reduces a model reply to one plain title, or null when nothing usable is left. */
export function cleanTitle(raw: string): string | null {
  const line = (raw.split("\n").find((l) => l.trim() !== "") ?? "")
    .replace(/^\s*title\s*:\s*/i, "")
    .replace(/^[\s"'`*#_>-]+|[\s"'`*_]+$/g, "")
    .replace(/[.!?:;,]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (line === "") return null;
  if (line.length <= MAX_TITLE) return line;
  const cut = line.lastIndexOf(" ", MAX_TITLE);
  return line.slice(0, cut > 0 ? cut : MAX_TITLE);
}

/** True while the session is untitled or still has its first-message title. */
export function isPlaceholder(session: Session): boolean {
  return session.title === null || session.title === session.settings.titlePlaceholder;
}

export function registerNaming(ctx: PluginContext): void {
  const inFlight = new Set<string>();
  const doneKey = (id: string) => `named:${id}`;
  const failKey = (id: string) => `nameFailures:${id}`;

  async function setPlaceholder(id: string, parts: Part[]): Promise<void> {
    const session = ctx.store.sessions.get(id);
    if (session?.title !== null) return;
    const patch = placeholderPatch(session, textOf(parts));
    if (patch) await ctx.store.sessions.update(id, patch);
  }

  // spec-gap: §8.4 assigns placeholder titles to the agent. The context manager owns both naming steps.
  ctx.events.after("message.create", async ({ cancelled, payload: { message, parts } }) => {
    if (!cancelled && message.role === "user" && message.status === "complete") {
      await setPlaceholder(message.sessionId, parts);
    }
  });

  ctx.events.after("core.ready", () => {
    void (async () => {
      for (const session of ctx.store.sessions.list({})) {
        if (ctx.signal.aborted) return;
        if (session.title !== null) continue;
        try {
          const first = ctx.store.messages.list(session.id).find(({ message }) => message.role === "user");
          if (first) await setPlaceholder(session.id, first.parts);
        } catch (error) {
          ctx.log.warn("session title backfill failed", { sessionId: session.id, error: String(error) });
        }
      }
    })().catch((error) => ctx.log.warn("session title backfill failed", { error: String(error) }));
  });

  async function name(session: Session, provider: string): Promise<void> {
    const utility = ctx.scopes.maybe("inference", provider)?.utility;
    if (!utility?.model()) return;
    const entries = ctx.store.messages.list(session.id);
    const firstUser = entries.find((e) => e.message.role === "user");
    const userText = firstUser ? textOf(firstUser.parts).trim() : "";
    if (!isPlaceholder(session)) {
      ctx.storage.kv.set(doneKey(session.id), true);
      return;
    }
    const reply = entries.find((e) => e.message.role === "assistant" && textOf(e.parts).trim() !== "");
    if (userText === "" || !reply) return;
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    const raw = await utility.complete(
      {
        system: SYSTEM,
        prompt: `User: ${userText.slice(0, MAX_SNIPPET)}\n\nAssistant: ${textOf(reply.parts).trim().slice(0, MAX_SNIPPET)}`,
        maxOutputTokens: 40,
      },
      signal,
    );
    const title = cleanTitle(raw);
    if (title === null) throw new Error("the utility model returned no usable title");
    const fresh = ctx.store.sessions.get(session.id);
    if (!fresh || !isPlaceholder(fresh)) return;
    const { titlePlaceholder: _, ...settings } = fresh.settings;
    await ctx.store.sessions.update(session.id, { title, settings });
    ctx.storage.kv.set(doneKey(session.id), true);
  }

  ctx.events.after("run.end", (e) => {
    const { run } = e.payload;
    if (e.cancelled || run.status !== "complete" || !run.provider || !autoNameSessions(ctx)) return;
    const session = ctx.store.sessions.get(run.sessionId);
    if (!session || inFlight.has(session.id) || ctx.storage.kv.get(doneKey(session.id))) return;
    if ((ctx.storage.kv.get<number>(failKey(session.id)) ?? 0) >= MAX_FAILURES) return;
    inFlight.add(session.id);
    void name(session, run.provider)
      .catch((error) => {
        const failures = (ctx.storage.kv.get<number>(failKey(session.id)) ?? 0) + 1;
        ctx.storage.kv.set(failKey(session.id), failures);
        ctx.log.warn("session naming failed", { sessionId: session.id, failures, error: String(error) });
      })
      .finally(() => inFlight.delete(session.id));
  });

  ctx.events.after("session.delete", (e) => {
    if (e.cancelled) return;
    ctx.storage.kv.delete(doneKey(e.payload.session.id));
    ctx.storage.kv.delete(failKey(e.payload.session.id));
  });
}
