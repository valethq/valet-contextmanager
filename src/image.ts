import { homedir } from "node:os";
import { extname, resolve } from "node:path";
import type { PluginContext, ToolDefinition } from "@valethq/sdk";

const MAX_BYTES = 8 * 1024 * 1024;
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

interface ViewImageInput {
  path: string;
}

const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

export function viewImageTool(ctx: PluginContext): ToolDefinition<ViewImageInput> {
  return {
    name: "view_image",
    description:
      "Look at an image file on disk (png, jpeg, gif, webp, up to 8 MB). The image comes back as image content, so use this to inspect screenshots and generated pictures. Small pixel art is easier to read if you upscale it first.",
    minRole: "owner",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Absolute path, ~/path, or relative to the session cwd." },
      },
    },
    async invoke(input, call) {
      if (call.role !== "owner") return fail("view_image is only available to the owner.");
      if (typeof input?.path !== "string" || !input.path.trim()) return fail("view_image needs a path.");
      const p = input.path.startsWith("~/") ? homedir() + input.path.slice(1) : resolve(call.cwd, input.path);
      const mime = MIME[extname(p).toLowerCase()];
      if (!mime) return fail(`Unsupported image type "${extname(p) || p}". Use png, jpeg, gif or webp.`);
      const file = Bun.file(p);
      if (!(await file.exists())) return fail(`No such file: ${p}`);
      if (file.size > MAX_BYTES) return fail(`${p} is ${file.size} bytes; the limit is ${MAX_BYTES}.`);
      const { id } = await ctx.store.blobs.put(await file.bytes(), { mime, name: p.split("/").pop() });
      return {
        content: [
          { type: "image", mime, blobId: id },
          { type: "text", text: `${p} (${mime}, ${file.size} bytes)` },
        ],
      };
    },
  };
}
