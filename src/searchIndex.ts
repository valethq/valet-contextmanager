import type { Message, Part, PluginContext } from "@valethq/sdk";

const MIGRATIONS = [
  {
    id: "001_search",
    up: `CREATE TABLE p_contextmanager_msgs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX p_contextmanager_msgs_session ON p_contextmanager_msgs(session_id);
    CREATE TABLE p_contextmanager_seen (session_id TEXT PRIMARY KEY, last_message_at INTEGER);
    CREATE VIRTUAL TABLE p_contextmanager_search USING fts5(text, tokenize = 'porter unicode61');`,
  },
];

const FTS = "p_contextmanager_search";
const MAX_TERMS = 12;

export interface SearchHit {
  messageId: string;
  sessionId: string;
  seq: number;
  role: string;
  createdAt: number;
  snippet: string;
}

export interface SearchQuery {
  query: string;
  limit: number;
  sessionId?: string;
  projectId?: string;
  /** Sessions this returns false for never appear in hits; they do not count toward the limit. */
  allow?: (sessionId: string) => boolean;
}

export interface SearchIndex {
  /** Resolves once the boot-time catch-up over existing sessions has finished. */
  readonly ready: Promise<void>;
  search(q: SearchQuery): SearchHit[];
}

/** Text a person could plausibly search for: messages, custom parts, compaction summaries and file names. */
export function searchableText(parts: Part[]): string {
  const out: string[] = [];
  for (const { data } of parts) {
    if (data.type === "text" || data.type === "custom") out.push(data.text);
    else if (data.type === "compaction" && data.status === "completed" && data.summary)
      out.push(data.summary);
    else if (data.type === "file") out.push(data.name);
  }
  return out.join("\n").trim();
}

function matchExpression(query: string, joiner: " " | " OR "): string | undefined {
  const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, MAX_TERMS);
  return terms?.length ? terms.map((t) => `"${t}"`).join(joiner) : undefined;
}

export function createSearchIndex(ctx: PluginContext): SearchIndex {
  ctx.storage.sql.migrate(MIGRATIONS);
  const db = ctx.storage.sql.db;

  const findRow = db.query<{ id: number }, [string]>(
    "SELECT id FROM p_contextmanager_msgs WHERE message_id = ?",
  );
  const dropRow = db.query("DELETE FROM p_contextmanager_msgs WHERE id = ?");
  const dropText = db.query(`DELETE FROM ${FTS} WHERE rowid = ?`);
  const addRow = db.query<{ id: number }, [string, string, string, number, string, number]>(
    `INSERT INTO p_contextmanager_msgs (message_id, session_id, project_id, seq, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
  );
  const addText = db.query(`INSERT INTO ${FTS} (rowid, text) VALUES (?, ?)`);

  const indexMessage = db.transaction((message: Message, parts: Part[], projectId: string) => {
    const old = findRow.get(message.id);
    if (old) {
      dropText.run(old.id);
      dropRow.run(old.id);
    }
    const text = searchableText(parts);
    if (text === "") return;
    const row = addRow.get(
      message.id,
      message.sessionId,
      projectId,
      message.seq,
      message.role,
      message.createdAt,
    );
    if (row) addText.run(row.id, text);
  });

  const dropSession = db.transaction((sessionId: string) => {
    for (const { id } of db
      .query<{ id: number }, [string]>("SELECT id FROM p_contextmanager_msgs WHERE session_id = ?")
      .all(sessionId)) {
      dropText.run(id);
      dropRow.run(id);
    }
    db.query("DELETE FROM p_contextmanager_seen WHERE session_id = ?").run(sessionId);
  });

  const projectOf = (sessionId: string) => ctx.store.sessions.get(sessionId)?.projectId;

  const guarded = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (error) {
      ctx.log.warn(`session index: ${what} failed`, { error: String(error) });
    }
  };

  ctx.events.after("message.create", (e) => {
    const { message, parts } = e.payload;
    const projectId = projectOf(message.sessionId);
    if (message.status === "streaming" || !projectId) return;
    guarded("message.create", () => indexMessage(message, parts, projectId));
  });

  ctx.events.after("message.complete", (e) => {
    const { message } = e.payload;
    const projectId = projectOf(message.sessionId);
    if (!projectId) return;
    guarded("message.complete", () => {
      const entry = ctx.store.messages
        .list(message.sessionId, { beforeSeq: message.seq + 1, limit: 1 })
        .find((m) => m.message.id === message.id);
      if (entry) indexMessage(entry.message, entry.parts, projectId);
    });
  });

  ctx.events.after("session.delete", (e) =>
    guarded("session.delete", () => dropSession(e.payload.session.id)),
  );

  async function catchUp(): Promise<void> {
    const seen = db.query<{ last_message_at: number | null }, [string]>(
      "SELECT last_message_at FROM p_contextmanager_seen WHERE session_id = ?",
    );
    const mark = db.query(
      "INSERT OR REPLACE INTO p_contextmanager_seen (session_id, last_message_at) VALUES (?, ?)",
    );
    const live = new Set<string>();
    for (const session of ctx.store.sessions.list({})) {
      if (ctx.signal.aborted) return;
      live.add(session.id);
      const prior = seen.get(session.id);
      if (prior && prior.last_message_at === session.lastMessageAt) continue;
      guarded("catch-up", () => {
        for (const { message, parts } of ctx.store.messages.list(session.id)) {
          if (message.status !== "streaming") indexMessage(message, parts, session.projectId);
        }
        mark.run(session.id, session.lastMessageAt);
      });
      await Bun.sleep(0);
    }
    for (const { session_id } of db
      .query<{ session_id: string }, []>("SELECT DISTINCT session_id FROM p_contextmanager_msgs")
      .all()) {
      if (!live.has(session_id)) guarded("prune", () => dropSession(session_id));
    }
  }

  const ready = catchUp().catch((error) =>
    ctx.log.warn("session index: catch-up failed", { error: String(error) }),
  );

  function run(match: string, q: SearchQuery): SearchHit[] {
    const where = [`${FTS} MATCH ?1`];
    const params: (string | number)[] = [match];
    if (q.sessionId) where.push(`m.session_id = ?${params.push(q.sessionId)}`);
    if (q.projectId) where.push(`m.project_id = ?${params.push(q.projectId)}`);
    const stmt = db.query<
      {
        message_id: string;
        session_id: string;
        seq: number;
        role: string;
        created_at: number;
        snippet: string;
      },
      (string | number)[]
    >(
      `SELECT m.message_id, m.session_id, m.seq, m.role, m.created_at,
              snippet(${FTS}, 0, '[[', ']]', '...', 24) AS snippet
       FROM ${FTS} JOIN p_contextmanager_msgs AS m ON m.id = ${FTS}.rowid
       WHERE ${where.join(" AND ")}
       ORDER BY ${FTS}.rank`,
    );
    // Stream one ranked scan so denied hits never restart the query; the first `limit` allowed hits end it.
    const hits: SearchHit[] = [];
    for (const r of stmt.iterate(...params)) {
      if (!q.allow || q.allow(r.session_id))
        hits.push({
          messageId: r.message_id,
          sessionId: r.session_id,
          seq: r.seq,
          role: r.role,
          createdAt: r.created_at,
          snippet: r.snippet,
        });
      if (hits.length >= q.limit) break;
    }
    return hits;
  }

  return {
    ready,
    search(q) {
      const all = matchExpression(q.query, " ");
      if (!all) return [];
      const hits = run(all, q);
      if (hits.length > 0) return hits;
      const any = matchExpression(q.query, " OR ");
      return any && any !== all ? run(any, q) : [];
    },
  };
}
