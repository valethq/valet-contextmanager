import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  Message,
  ModelInfo,
  Part,
  PartData,
  PluginContext,
  Project,
  ScopeDefinition,
  Session,
} from "@valethq/sdk";
import plugin from "../src/index";
import type { ContextManager } from "../src/types";

const dirs: string[] = [];

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
}

export function boot(
  o: {
    sessions?: Session[];
    projects?: Project[];
    messages?: Record<string, { message: Message; parts: Part[] }[]>;
  } = {},
): Booted {
  const warns: Booted["warns"] = [];
  const defined: Booted["defined"] = [];
  const provided: Booted["provided"] = [];
  const sessions = new Map((o.sessions ?? []).map((s) => [s.id, s]));
  const projects = new Map((o.projects ?? []).map((p) => [p.id, p]));
  const kv = new Map<string, unknown>();
  const messages = o.messages ?? {};
  const ctx = {
    plugin: { id: "valet-contextmanager", version: "0.1.0", dir: "", manifest: {} },
    config: {},
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
      maybe: () => undefined,
      all: () => [],
      watch: () => ({ dispose() {} }),
    },
    store: {
      sessions: { get: (id: string) => sessions.get(id) },
      projects: { get: (id: string) => projects.get(id) },
      messages: {
        list: (sessionId: string) => messages[sessionId] ?? [],
        create: async (input: { sessionId: string; role: Message["role"]; parts: PartData[] }) => {
          const e = entry(input.sessionId, input.role, input.parts);
          messages[input.sessionId] = [...(messages[input.sessionId] ?? []), e];
          return e.message;
        },
      },
    },
    storage: {
      kv: {
        get: <T>(k: string) => kv.get(k) as T | undefined,
        set: (k: string, v: unknown) => void kv.set(k, v),
        delete: (k: string) => void kv.delete(k),
        list: () => [...kv.keys()],
      },
    },
    signal: new AbortController().signal,
    onDispose() {},
  } as unknown as PluginContext;
  plugin.activate(ctx);
  const impl = provided[0]?.impl as ContextManager;
  return { impl, warns, defined, provided, kv };
}
