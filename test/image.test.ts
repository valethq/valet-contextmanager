import { afterAll, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginContext, ToolCall } from "@valethq/sdk";
import { viewImageTool } from "../src/image";
import { cleanup, workspace } from "./helpers";

afterAll(cleanup);

const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

function setup() {
  const puts: { size: number; meta: { mime?: string; name?: string } }[] = [];
  const ctx = {
    store: {
      blobs: {
        put: async (bytes: Uint8Array, meta: { mime?: string; name?: string }) => {
          puts.push({ size: bytes.length, meta });
          return { id: `b${puts.length}` };
        },
      },
    },
  } as unknown as PluginContext;
  const call = (cwd: string, role = "owner") => ({ cwd, role }) as unknown as ToolCall;
  return { tool: viewImageTool(ctx), puts, call };
}

test("returns the file as an image blob, resolving relative paths against cwd", async () => {
  const dir = await workspace({});
  await writeFile(join(dir, "shot.png"), PNG);
  const { tool, puts, call } = setup();
  const r = await tool.invoke({ path: "shot.png" }, call(dir));
  expect(r.isError).toBeUndefined();
  expect(r.content[0]).toEqual({ type: "image", mime: "image/png", blobId: "b1" });
  expect(puts).toEqual([{ size: PNG.length, meta: { mime: "image/png", name: "shot.png" } }]);
});

test("rejects missing files, unsupported types and non-owners", async () => {
  const dir = await workspace({ "a.txt": "x" });
  const { tool, puts, call } = setup();
  expect((await tool.invoke({ path: "nope.png" }, call(dir))).isError).toBe(true);
  expect((await tool.invoke({ path: "a.txt" }, call(dir))).isError).toBe(true);
  expect((await tool.invoke({ path: "a.txt" }, call(dir, "guest"))).isError).toBe(true);
  expect(puts).toEqual([]);
});
