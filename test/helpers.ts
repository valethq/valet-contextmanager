import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  Audience,
  Caller,
  ContextManager,
  Message,
  ModelInfo,
  Part,
  PartData,
  PluginContext,
  PolicyProvider,
  Project,
  Role,
  ScopeDefinition,
  Session,
  ToolDefinition,
  ToolProvider,
  UtilityModel,
} from "@valethq/sdk";
import manifest from "../manifest.json";
import plugin from "../src/index";
import type { ContextConfig } from "../src/settings";

const dirs: string[] = [];

export const PRINCIPALS: Record<string, Role> = {
  boss: "owner",
  boss2: "owner",
  pal: "trusted",
  nobody: "guest",
};

export const caller = (principalId = "boss", audience?: Audience): Caller => ({
  plugin: "valet-agent",
  actor: { principalId, role: PRINCIPALS[principalId] ?? "guest", ...(audience && { audience }) },
});

/** A policy that hands every permission to trusted and owner subjects, like a broad `contextmanager:*` grant. */
export const generousPolicy: PolicyProvider = {
  check: (subject, permission) =>
    subject.role === "guest"
      ? { allow: false, by: "valet-policy", reason: `${permission} denied` }
      : { allow: true },
};

/** A minimal ctx for tools built outside `boot`: ACL state plus whatever `store` pieces the tool uses. */
export function aclCtx(store: Record<string, unknown> = {}, policy?: PolicyProvider): PluginContext {
  return {
    plugin: { id: "valet-contextmanager", version: "0.1.0", dir: "", manifest },
    acl: { permission: (name: string) => declaredPermissions()[name], credential: () => undefined },
    scopes: { maybe: (scope: string) => (scope === "policy" ? policy : undefined) },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    store: {
      principals: {
        get: (id: string) => (PRINCIPALS[id] ? { id, displayName: id, role: PRINCIPALS[id] } : undefined),
      },
      sessions: { get: () => undefined },
      ...store,
    },
  } as unknown as PluginContext;
}

export const declaredPermissions = (): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(manifest.acl.permissions).map(([name, def]) => [`contextmanager:${name}`, def]),
  );

export async function workspace(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "valet-cm-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content);
  }
  return dir;
}

export async function cleanup(): Promise<void> {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
}

export function dayKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function project(id: string, workspaceDir: string, settings: Record<string, unknown> = {}): Project {
  return { id, name: id, workspaceDir, settings, createdAt: 0, updatedAt: 0 };
}

export function session(id: string, projectId: string): Session {
  return {
    id,
    projectId,
    title: null,
    color: null,
    parentSessionId: null,
    status: "idle",
    settings: {},
    providerState: {},
    createdAt: 0,
    updatedAt: 0,
    lastMessageAt: null,
    lastResponseAt: null,
  };
}

export function model(contextWindow: number): ModelInfo {
  return {
    id: "test-model",
    name: "Test",
    contextWindow,
    maxOutputTokens: 4096,
    input: ["text"],
    reasoning: false,
  };
}

let seq = 0;

export function entry(
  sessionId: string,
  role: Message["role"],
  parts: PartData[],
  extra: Partial<Message> = {},
): { message: Message; parts: Part[] } {
  seq += 1;
  const id = `m${seq}`;
  const message: Message = {
    id,
    sessionId,
    seq,
    role,
    authorPrincipalId: null,
    runId: null,
    status: "complete",
    origin: null,
    meta: {},
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  };
  return {
    message,
    parts: parts.map((data, idx) => ({
      id: `${id}p${idx}`,
      messageId: id,
      idx,
      status: "complete" as const,
      type: data.type,
      data,
      createdAt: 0,
      updatedAt: 0,
    })),
  };
}

export const text = (t: string): PartData => ({ type: "text", text: t });

export const AGENTS_RULE_NOTE =
  "(Devin CLI also loads this file as an always-on rule cut at 16 KB; this full copy supersedes it.)";

export interface Booted {
  impl: ContextManager;
  warns: { msg: string; data?: Record<string, unknown> }[];
  defined: ScopeDefinition[];
  provided: { scope: string; impl: unknown; key?: string }[];
  kv: Map<string, unknown>;
  titles: { id: string; title: string }[];
  session(id: string): Session | undefined;
  /** The keyless tools@1 provider's owner-role tool list (view_image, session_search, session_view). */
  tools: ToolDefinition[];
  /** Fires the plugin's `after` hooks for an event, like the kernel would. */
  fire(name: string, payload: unknown): Promise<void>;
  /** skill_read's provider (key "skills"): the tools a run in this session and role would get. */
  skillTools(sessionId: string, role: Role, who?: Caller): Promise<ToolDefinition[]>;
  /** The keyless tools@1 provider's listing for a run with this role and caller. */
  listTools(role: Role, who?: Caller, sessionId?: string): Promise<ToolDefinition[]>;
  /** What core does on a settings save: the new block replaces ctx.config. */
  setConfig(patch: Partial<ContextConfig>): void;
  /** A project's overrides, as core's project layer would give them to ctx.configFor. */
  setProjectConfig(projectId: string, patch: Partial<ContextConfig>): void;
}

export function boot(
  o: {
    sessions?: Session[];
    projects?: Project[];
    messages?: Record<string, { message: Message; parts: Part[] }[]>;
    inference?: Record<string, { utility?: UtilityModel }>;
    valetHome?: string;
    config?: ContextConfig;
    policy?: PolicyProvider;
    /** Run ids a tool or context call is stamped with, and the caller each resolves to. */
    runCallers?: Record<string, Caller>;
  } = {},
): Booted {
  const warns: Booted["warns"] = [];
  const defined: Booted["defined"] = [];
  const provided: Booted["provided"] = [];
  const sessions = new Map((o.sessions ?? []).map((s) => [s.id, s]));
  const projects = new Map((o.projects ?? []).map((p) => [p.id, p]));
  const kv = new Map<string, unknown>();
  let current: ContextConfig = { ...(o.config ?? {}) };
  const projectConfig = new Map<string, Partial<ContextConfig>>();
  const messages = o.messages ?? {};
  const titles: Booted["titles"] = [];
  const hooks = new Map<string, ((e: unknown) => unknown)[]>();
  const db = new Database(":memory:");
  const ctx = {
    plugin: { id: "valet-contextmanager", version: "0.1.0", dir: "", manifest: {} },
    acl: { permission: (name: string) => declaredPermissions()[name], credential: () => undefined },
    get config() {
      return current;
    },
    configFor: (projectId: string) =>
      projectConfig.has(projectId) ? { ...current, ...projectConfig.get(projectId) } : current,
    onConfigChange() {},
    log: {
      debug() {},
      info() {},
      warn: (msg: string, data?: Record<string, unknown>) => warns.push({ msg, data }),
      error() {},
    },
    scopes: {
      define: (d: ScopeDefinition) => defined.push(d),
      provide: (scope: string, impl: unknown, opts?: { key?: string }) => {
        provided.push({ scope, impl, key: opts?.key });
        return { dispose() {} };
      },
      get: () => {
        throw new Error("no scopes in test ctx");
      },
      maybe: (scope: string, key?: string) =>
        scope === "inference" ? o.inference?.[key ?? ""] : scope === "policy" ? o.policy : undefined,
      all: () => [],
      watch: () => ({ dispose() {} }),
    },
    events: {
      after: (name: string, fn: (e: unknown) => unknown) => {
        hooks.set(name, [...(hooks.get(name) ?? []), fn]);
        return { active: true, disconnect() {} };
      },
    },
    store: {
      principals: {
        get: (id: string) => (PRINCIPALS[id] ? { id, displayName: id, role: PRINCIPALS[id] } : undefined),
      },
      sessions: {
        get: (id: string) => sessions.get(id),
        list: () => [...sessions.values()],
        update: async (id: string, patch: { title?: string; settings?: Session["settings"] }) => {
          const current = sessions.get(id);
          if (!current || (patch.title === undefined && patch.settings === undefined)) return current;
          const next = {
            ...current,
            title: patch.title ?? current.title,
            settings: patch.settings ?? current.settings,
          };
          sessions.set(id, next);
          if (patch.title !== undefined) titles.push({ id, title: patch.title });
          return next;
        },
      },
      projects: { get: (id: string) => projects.get(id) },
      runs: {
        caller: (runId: string) => {
          const who = o.runCallers?.[runId];
          if (!who) throw new Error(`unknown run "${runId}"`);
          return who;
        },
      },
      messages: {
        list: (sessionId: string, q: { beforeSeq?: number; limit?: number } = {}) => {
          const all = (messages[sessionId] ?? []).filter(
            (e) => q.beforeSeq === undefined || e.message.seq < q.beforeSeq,
          );
          return q.limit === undefined ? all : all.slice(-q.limit);
        },
        create: async (input: { sessionId: string; role: Message["role"]; parts: PartData[] }) => {
          const e = entry(input.sessionId, input.role, input.parts);
          messages[input.sessionId] = [...(messages[input.sessionId] ?? []), e];
          return { message: e.message, parts: e.parts };
        },
        openPart: (messageId: string, data: PartData) => {
          const owner = Object.values(messages)
            .flat()
            .find((e) => e.message.id === messageId);
          const part: Part = {
            id: `${messageId}p${owner?.parts.length ?? 0}`,
            messageId,
            idx: owner?.parts.length ?? 0,
            status: "streaming",
            type: data.type,
            data,
            createdAt: 0,
            updatedAt: 0,
          };
          owner?.parts.push(part);
          return {
            partId: part.id,
            append() {},
            replace(next: PartData) {
              part.data = next;
            },
            close(status: "complete" | "error" | "interrupted", final?: PartData) {
              if (final) part.data = final;
              part.status = status === "complete" ? "complete" : "error";
            },
          };
        },
        complete: async () => {},
      },
    },
    storage: {
      sql: {
        db,
        migrate: (ms: { up: string }[]) => {
          for (const m of ms) db.exec(m.up);
        },
      },
      kv: {
        get: <T>(k: string) => kv.get(k) as T | undefined,
        set: (k: string, v: unknown) => void kv.set(k, v),
        delete: (k: string) => void kv.delete(k),
        list: () => [...kv.keys()],
      },
    },
    paths: {
      data: "/nonexistent",
      cache: "/nonexistent",
      valetHome: o.valetHome ?? "/nonexistent-valet-home",
    },
    signal: new AbortController().signal,
    onDispose() {},
  } as unknown as PluginContext<ContextConfig>;
  plugin.activate(ctx);
  const impl = provided[0]?.impl as ContextManager;
  const fire = async (name: string, payload: unknown) => {
    for (const fn of hooks.get(name) ?? []) await fn({ payload, cancelled: false });
    await new Promise((r) => setTimeout(r, 0));
  };
  const toolProvider = provided.find((p) => p.scope === "tools" && p.key === undefined)?.impl as ToolProvider;
  const listTools = async (role: Role, who: Caller = caller(), sessionId = "s") =>
    toolProvider.list({ sessionId, projectId: "p", role, caller: who });
  const tools = toolProvider.list({
    sessionId: "s",
    projectId: "p",
    role: "owner",
    caller: caller(),
  }) as ToolDefinition[];
  const skillProvider = provided.find((p) => p.scope === "tools" && p.key === "skills")?.impl as ToolProvider;
  const skillTools = async (sessionId: string, role: Role, who: Caller = caller()) =>
    skillProvider.list({ sessionId, projectId: "p", role, caller: who });
  const setConfig = (patch: Partial<ContextConfig>) => {
    current = { ...current, ...patch };
  };
  const setProjectConfig = (projectId: string, patch: Partial<ContextConfig>) => {
    projectConfig.set(projectId, patch);
  };
  return {
    impl,
    warns,
    defined,
    provided,
    kv,
    titles,
    session: (id) => sessions.get(id),
    tools,
    fire,
    skillTools,
    listTools,
    setConfig,
    setProjectConfig,
  };
}
