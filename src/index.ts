import { definePlugin, defineScope } from "@valethq/sdk";
import { createContextManager } from "./context";
import { viewImageTool } from "./image";
import { registerNaming } from "./naming";
import { createSearchIndex } from "./searchIndex";
import { sessionSearchTool, sessionViewTool } from "./sessionTools";
import { skillReadTool } from "./skillTool";
import { loadSkills } from "./skillLoad";
import type { ContextConfig } from "./settings";

export default definePlugin<ContextConfig>({
  activate(ctx) {
    ctx.onConfigChange(() => {}); // config is read from ctx.config at use, so a reload needs no action
    ctx.scopes.define(defineScope({ name: "context", version: 1, cardinality: "one" }));
    ctx.scopes.provide("context", createContextManager(ctx), { key: "valet-contextmanager" });
    registerNaming(ctx);
    const index = createSearchIndex(ctx);
    ctx.scopes.provide("tools", {
      list: ({ role }) =>
        role === "owner" ? [viewImageTool(ctx), sessionSearchTool(ctx, index), sessionViewTool(ctx)] : [],
    });
    ctx.scopes.provide(
      "tools",
      {
        async list({ sessionId, role }) {
          const any = (await loadSkills(ctx, sessionId, role)).length > 0;
          return any ? [skillReadTool((call) => loadSkills(ctx, call.sessionId, call.role))] : [];
        },
      },
      { key: "skills" },
    );
  },
});
