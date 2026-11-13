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
  /** Writes a compaction-summary part. Older messages stay stored but leave the prompt window. */
  compact(req: {
    sessionId: string;
    reason: "auto" | "manual" | "resume";
  }): Promise<{ summaryPartId: string }>;
}

declare module "@valethq/sdk" {
  interface ValetScopes {
    context: ContextManager;
  }
}
