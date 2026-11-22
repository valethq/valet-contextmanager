import { homedir } from "node:os";
import { extname, resolve } from "node:path";
import { defineTool, type PluginContext, type ToolDefinition } from "@valethq/sdk";

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

function sniffImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6) {
    const head = String.fromCharCode(...bytes.subarray(0, 6));
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(...bytes.subarray(0, 4));
    const webp = String.fromCharCode(...bytes.subarray(8, 12));
    if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  }
  return null;
}

export function viewImageTool(ctx: PluginContext): ToolDefinition<ViewImageInput> {
  const def: ToolDefinition<ViewImageInput> = {
    name: "view_image",
    description:
      "Look at an image file on disk (png, jpeg, gif, webp, up to 8 MB). The image comes back as image content, so use this to inspect screenshots and generated pictures. Small pixel art is easier to read if you upscale it first.",
    minRole: "owner",
    permission: "contextmanager:image.view",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string", description: "Absolute path, ~/path, or relative to the session cwd." },
      },
    },
    async invoke(input, call) {
      if (typeof input?.path !== "string" || !input.path.trim()) return fail("view_image needs a path.");
      const p = input.path.startsWith("~/") ? homedir() + input.path.slice(1) : resolve(call.cwd, input.path);
      const mime = MIME[extname(p).toLowerCase()];
      if (!mime) return fail(`Unsupported image type "${extname(p) || p}". Use png, jpeg, gif or webp.`);
      const file = Bun.file(p);
      if (!(await file.exists())) return fail(`No such file: ${p}`);
      if (file.size > MAX_BYTES) return fail(`${p} is ${file.size} bytes; the limit is ${MAX_BYTES}.`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const sniffed = sniffImageMime(bytes);
      if (!sniffed) return fail(`"${p}" is not a supported image (png, jpeg, gif, or webp).`);
      const { id } = await ctx.store.blobs.put(bytes, { mime: sniffed, name: p.split("/").pop() });
      return {
        content: [
          { type: "image", mime: sniffed, blobId: id },
          { type: "text", text: `${p} (${sniffed}, ${file.size} bytes)` },
        ],
      };
    },
  };
  return defineTool(def, ctx);
}
