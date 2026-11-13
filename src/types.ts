import type { ModelInfo, ModelMessage, Role } from "@valethq/sdk";

export interface PersonaFile {
  path: string;
  role: "agents" | "user" | "memory" | "soul" | "identity" | "daily" | "other";
  content: string;
}

export interface BuiltContext {
  system: string;
  messages: ModelMessage[];
  estimatedTokens: number;
  files: PersonaFile[];
}

/** Who compacts: valet summarizes with a model it is given, or a harness compacted itself and valet only marks it. */
export type CompactionBy =
  | { kind: "valet"; summarize(transcript: string): Promise<string> }
  | { kind: "harness"; label: string };

export interface ContextManager {
  /** model-kind: full prompt within budget (persona files, compaction summary, recent history). */
  build(req: { sessionId: string; runId: string; model: ModelInfo; role: Role }): Promise<BuiltContext>;
  /** agent-kind: persona/memory preamble for a new or reseeded remote session. */
  preamble(req: {
    sessionId: string;
    role: Role;
    model?: { id: string; contextWindow?: number };
  }): Promise<string>;
  shouldCompact(req: {
    sessionId: string;
    model: ModelInfo;
    lastUsage: { inputTokens?: number; contextTokens?: number };
  }): Promise<boolean>;
  /**
   * Records a `compaction` part in the same chat (never a new session). `by: valet` summarizes the
   * chat since the last valet summary and the summary replaces it in history; `by: harness` writes
   * a marker only and leaves valet's history untouched.
   */
  compact(req: { sessionId: string; reason: "auto" | "manual"; by: CompactionBy }): Promise<void>;
}

declare module "@valethq/sdk" {
  interface ValetScopes {
    context: ContextManager;
  }
}
