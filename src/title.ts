import type { Session } from "@valethq/sdk";

export function titleFrom(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.startsWith("/")) return null;
  const line = (trimmed.split("\n").find((l) => l.trim() !== "") ?? "")
    .replace(/^[#>*`\s-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (line === "") return null;
  if (line.length <= 60) return line;
  const cut = line.lastIndexOf(" ", 60);
  return `${line.slice(0, cut > 0 ? cut : 60)}…`;
}

/** Patch that titles `session` from `text` and records the title as a placeholder, or null when there is nothing to title. */
export function placeholderPatch(session: Session, text: string): Pick<Session, "title" | "settings"> | null {
  const title = titleFrom(text);
  return title ? { title, settings: { ...session.settings, titlePlaceholder: title } } : null;
}
