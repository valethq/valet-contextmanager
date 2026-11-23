import { afterAll, describe, expect, test } from "bun:test";
import type { Caller, PolicyProvider, ToolCall, ToolDefinition, ToolResult } from "@valethq/sdk";
import manifest from "../manifest.json";
import {
  boot,
  caller,
  cleanup,
  entry,
  generousPolicy,
  model,
  project,
  session,
  text,
  workspace,
} from "./helpers";

afterAll(cleanup);

const call = (who: ReturnType<typeof caller>, role: ToolCall["role"] = "owner", sessionId = "s1") =>
  ({
    sessionId,
    runId: "r",
    callId: "c",
    role,
    caller: who,
    cwd: "/",
    signal: new AbortController().signal,
  }) as ToolCall;

const out = (r: ToolResult) => r.content.map((c) => ("text" in c ? c.text : "")).join("");
const names = (tools: ToolDefinition[]) => tools.map((t) => t.name);

function setup(policy?: PolicyProvider) {
  const messages = {
    s1: [entry("s1", "user", [text("renew the coturn certificate")])],
    s2: [
      // Repeated term + both query words: denied hits must outrank s1's and match the all-word query.
      entry("s2", "user", [text("coturn coturn coturn zebra secrets live in project two")]),
      entry("s2", "assistant", [text("more coturn for the denied session")]),
    ],
  };
  return boot({
    sessions: [session("s1", "p1"), session("s2", "p2")],
    projects: [project("p1", "/tmp"), project("p2", "/tmp")],
    messages,
    ...(policy && { policy }),
  });
}

describe("manifest", () => {
  test("declares the four permissions with their default tiers", () => {
    expect(manifest.acl.permissions).toEqual({
      "image.view": { summary: "View images from the workspace", default: "owner" },
      "session.search": { summary: "Search past sessions", default: "owner" },
      "session.read": { summary: "Read past sessions", default: "owner" },
      "skill.read": { summary: "Read skills", default: "guest" },
    });
  });
});

describe("tools@1 listing", () => {
  test("an owner actor in an owner run gets all three tools, each with its permission", async () => {
    const b = setup();
    const tools = await b.listTools("owner");
    expect(names(tools)).toEqual(["view_image", "session_search", "session_view"]);
    expect(tools.map((t) => t.permission)).toEqual([
      "contextmanager:image.view",
      "contextmanager:session.search",
      "contextmanager:session.read",
    ]);
  });

  test("minRole stays a floor on the run role, even when the policy grants the actor", async () => {
    const b = setup(generousPolicy);
    expect(await b.listTools("trusted", caller("pal"))).toEqual([]);
    expect(await b.listTools("guest", caller("nobody"))).toEqual([]);
  });

  test("without a policy provider a trusted actor misses the owner default; with a grant it passes", async () => {
    expect(await setup().listTools("owner", caller("pal"))).toEqual([]);
    expect(names(await setup(generousPolicy).listTools("owner", caller("pal")))).toEqual([
      "view_image",
      "session_search",
      "session_view",
    ]);
  });

  test("a guest actor and an actor-less caller get nothing", async () => {
    const b = setup(generousPolicy);
    expect(await b.listTools("owner", caller("nobody"))).toEqual([]);
    expect(await b.listTools("owner", { plugin: "valet-agent" })).toEqual([]);
  });

  test("an audience reader without the permission removes the tools", async () => {
    const b = setup();
    expect(await b.listTools("owner", caller("boss", { principals: ["boss2", "nobody"] }))).toEqual([]);
    expect(await b.listTools("owner", caller("boss", { tier: "guest" }))).toEqual([]);
    expect(await b.listTools("owner", caller("boss", { principals: ["boss2"] }))).toHaveLength(3);
  });

  test("a credential or run cap that omits the permission removes the tool", async () => {
    const b = setup();
    const actor = caller().actor as NonNullable<Caller["actor"]>;
    const limited: Caller = {
      plugin: "valet-agent",
      actor: { ...actor, cap: ["contextmanager:session.search", "contextmanager:session.read"] },
    };
    expect(names(await b.listTools("owner", limited))).toEqual(["session_search", "session_view"]);
  });
});

describe("invoke re-checks the permission", () => {
  test("a listed tool refuses a call from a caller that lacks the permission", async () => {
    const b = setup();
    const view = b.tools.find((t) => t.name === "session_view") as ToolDefinition<{ sessionId: string }>;
    const ok = await view.invoke({ sessionId: "s1" }, call(caller()));
    expect(ok.isError).toBeUndefined();
    const denied = await view.invoke({ sessionId: "s1" }, call(caller("pal")));
    expect(denied.isError).toBe(true);
    expect(out(denied)).toContain("session_view denied");
    const lowRun = await view.invoke({ sessionId: "s1" }, call(caller(), "trusted"));
    expect(lowRun.isError).toBe(true);
  });

  test("view_image is refused to a non-owner actor before it touches the file", async () => {
    const b = setup();
    const image = b.tools.find((t) => t.name === "view_image") as ToolDefinition<{ path: string }>;
    const r = await image.invoke({ path: "/etc/hostname.png" }, call(caller("pal")));
    expect(r.isError).toBe(true);
    expect(out(r)).toContain("view_image denied");
  });
});

describe("session resources", () => {
  const noSecondProject: PolicyProvider = {
    check: (subject, permission, resource) =>
      subject.role === "guest" || resource?.id === "session:s2"
        ? { allow: false, by: "valet-policy", reason: `${permission} denied on ${resource?.id}` }
        : { allow: true },
  };

  test("session_view refuses a session the caller may not read, even from an allowed one", async () => {
    const b = setup(noSecondProject);
    const view = b.tools.find((t) => t.name === "session_view") as ToolDefinition<{ sessionId: string }>;
    expect((await view.invoke({ sessionId: "s1" }, call(caller()))).isError).toBeUndefined();
    const denied = await view.invoke({ sessionId: "s2" }, call(caller()));
    expect(denied.isError).toBe(true);
    expect(out(denied)).not.toContain("project two");
  });

  test("session_search drops hits from sessions the caller may not read", async () => {
    const b = setup(noSecondProject);
    const search = b.tools.find((t) => t.name === "session_search") as ToolDefinition<{ query: string }>;
    const r = await search.invoke({ query: "coturn" }, call(caller()));
    expect(out(r)).toContain("s1");
    expect(out(r)).not.toContain("s2");
  });

  test("denied sessions do not spend the limit or block the any-word fallback", async () => {
    const b = setup(noSecondProject);
    const search = b.tools.find((t) => t.name === "session_search") as ToolDefinition<{
      query: string;
      limit?: number;
    }>;
    const one = await search.invoke({ query: "coturn", limit: 1 }, call(caller()));
    expect(out(one)).toContain("s1");
    expect(out(one)).not.toContain("s2");
    const fallback = await search.invoke({ query: "coturn zebra" }, call(caller()));
    expect(out(fallback)).toContain("s1");
    expect(out(fallback)).not.toContain("s2");
  });
});

describe("skill_read", () => {
  async function withSkill(policy?: PolicyProvider, runCallers?: Record<string, Caller>) {
    const dir = await workspace({
      "skills/alpha/SKILL.md": "---\nname: alpha\ndescription: d\nminRole: guest\n---\n\nBody.\n",
    });
    return boot({
      sessions: [session("s1", "p1")],
      projects: [project("p1", dir)],
      ...(policy && { policy }),
      ...(runCallers && { runCallers }),
    });
  }

  test("is guest by default: a guest run and actor can list and read it", async () => {
    const b = await withSkill();
    const tools = await b.skillTools("s1", "guest", caller("nobody"));
    expect(names(tools)).toEqual(["skill_read"]);
    expect(tools[0]?.permission).toBe("contextmanager:skill.read");
    const r = await (tools[0] as ToolDefinition<{ name: string }>).invoke(
      { name: "alpha" },
      call(caller("nobody"), "guest"),
    );
    expect(out(r)).toContain("Body.");
  });

  test("a policy that withholds skill.read from guests removes and refuses the tool", async () => {
    const noGuests: PolicyProvider = {
      check: (subject, permission) =>
        subject.role === "guest"
          ? { allow: false, by: "valet-policy", reason: `${permission} denied` }
          : { allow: true },
    };
    const b = await withSkill(noGuests);
    expect(await b.skillTools("s1", "guest", caller("nobody"))).toEqual([]);
    const [tool] = await b.skillTools("s1", "owner", caller());
    const r = await (tool as ToolDefinition<{ name: string }>).invoke(
      { name: "alpha" },
      call(caller("nobody"), "guest"),
    );
    expect(r.isError).toBe(true);
    expect(out(r)).toContain("skill_read denied");
  });

  test("build does not advertise skills to a run whose caller lacks skill.read", async () => {
    const noSkillForPal: PolicyProvider = {
      check: (subject, permission) =>
        permission === "contextmanager:skill.read" && subject.principalId === "pal"
          ? { allow: false, by: "valet-policy", reason: "no skills for pal" }
          : { allow: true },
    };
    const b = await withSkill(noSkillForPal, { r1: caller("pal"), r2: caller("boss") });
    const denied = await b.impl.build({
      sessionId: "s1",
      runId: "r1",
      model: model(1_000_000),
      role: "trusted",
    });
    expect(denied.system).not.toContain("alpha");
    const allowed = await b.impl.build({
      sessionId: "s1",
      runId: "r2",
      model: model(1_000_000),
      role: "owner",
    });
    expect(allowed.system).toContain("alpha");
  });
});
