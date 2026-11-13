import { definePlugin, defineScope } from "@valethq/sdk";
import { createContextManager } from "./context";
import { registerSettings } from "./settings";
import "./types";

export default definePlugin({
  activate(ctx) {
    ctx.scopes.define(defineScope({ name: "context", version: 1, cardinality: "one" }));
    ctx.scopes.provide("context", createContextManager(ctx), { key: "valet-contextmanager" });
    registerSettings(ctx);
  },
});
