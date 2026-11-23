import { describe, expect, test } from "bun:test";
import type { Session } from "@valethq/sdk";
import { placeholderPatch, titleFrom } from "../src/title";

describe("titleFrom", () => {
  test("plain text is trimmed", () => {
    expect(titleFrom("  hello world  ")).toBe("hello world");
  });

  test("uses the first non-empty line and collapses whitespace", () => {
    expect(titleFrom("\n\nfirst   line\nsecond line")).toBe("first line");
  });

  test("long text truncates at the last space with an ellipsis", () => {
    const t = titleFrom(`${"word ".repeat(20)}end`) as string;
    expect(t.endsWith("…")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(61);
    expect(t.slice(0, -1)).not.toContain("  ");
  });

  test("long text without a space cuts at 60", () => {
    expect(titleFrom("x".repeat(70))).toBe(`${"x".repeat(60)}…`);
  });

  test("slash command -> null", () => {
    expect(titleFrom("/stop")).toBeNull();
    expect(titleFrom("   /model fake-agent:m2")).toBeNull();
  });

  test("leading markdown markers are stripped", () => {
    expect(titleFrom("## My Heading")).toBe("My Heading");
    expect(titleFrom("> quoted")).toBe("quoted");
    expect(titleFrom("- bullet")).toBe("bullet");
    expect(titleFrom("`code`")).toBe("code`");
  });

  test("empty -> null", () => {
    expect(titleFrom("")).toBeNull();
    expect(titleFrom("  \n\t  ")).toBeNull();
    expect(titleFrom("###")).toBeNull();
  });
});

describe("placeholderPatch", () => {
  const session = { title: null, settings: { persona: "p" } } as unknown as Session;

  test("sets the title and records it as the placeholder, keeping other settings", () => {
    expect(placeholderPatch(session, "## hello world")).toEqual({
      title: "hello world",
      settings: { persona: "p", titlePlaceholder: "hello world" },
    });
  });

  test("nothing to title -> null", () => {
    expect(placeholderPatch(session, "/stop")).toBeNull();
  });
});
