import { definePlugin, defineScope } from "@valethq/sdk";
import { createContextManager } from "./context";
import { viewImageTool } from "./image";
import { registerNaming } from "./naming";
import { createSearchIndex } from "./searchIndex";
import { sessionSearchTool, sessionViewTool } from "./sessionTools";
import { registerSettings } from "./settings";

export default definePlugin({
  activate(ctx) {
    ctx.scopes.define(defineScope({ name: "context", version: 1, cardinality: "one" }));
    ctx.scopes.provide("context", createContextManager(ctx), { key: "valet-contextmanager" });
    registerSettings(ctx);
    registerNaming(ctx);
    const index = createSearchIndex(ctx);
    ctx.scopes.provide("tools", {
      list: ({ role }) =>
        role === "owner" ? [viewImageTool(ctx), sessionSearchTool(ctx, index), sessionViewTool(ctx)] : [],
    });
  },
});
