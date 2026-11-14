import { afterEach, describe, expect, test } from "bun:test";
import {
  callTool,
  listTools,
  parseSkillMarkdown,
  slugify,
  usePlatformTools,
  type PlatformTools,
} from "../src/plugins/builtin-platform";

/**
 * Platform Tools: the deployment-changing builtin transport.
 *
 * Two properties carry the weight here. The actor is the authorization, and it has to be an
 * ADMINISTRATOR — a grant alone buys nothing, because these tools change the deployment rather
 * than one person's own rows; and every tool dispatches to the same store methods the admin
 * screens call, which the recording stub stands in for. SKILL.md parsing is pure, so it is
 * pinned directly.
 */

const CONNECTION = { url: "builtin://platform-tools", actorId: "admin-1", botId: "bot-1" };

function stub(overrides: Partial<PlatformTools> = {}): {
  tools: PlatformTools;
  calls: { method: string; input: unknown }[];
} {
  const calls: { method: string; input: unknown }[] = [];
  const tools: PlatformTools = {
    actorIsAdmin: async () => true,
    actorEmail: async (actorId) => `${actorId}@example.test`,
    addMcpServer: async (_actorId, input) => {
      calls.push({ method: "addMcpServer", input });
      return { id: input.id, title: input.title, toolCount: 3 };
    },
    installSkill: async (_actorId, input) => {
      calls.push({ method: "installSkill", input });
      return { slug: input.slug };
    },
    addCustomProvider: async (input) => {
      calls.push({ method: "addCustomProvider", input });
      return { id: input.id, path: "/deploy/providers.local.json" };
    },
    providerExists: (id) => id === "9router" || id === "openai",
    addAgent: async (_actorId, input) => {
      calls.push({ method: "addAgent", input });
      return { id: "agent-new", name: input.name, grantedTools: input.grants.length > 0 ? 2 : 0 };
    },
    ...overrides,
  };
  return { tools, calls };
}

afterEach(() => usePlatformTools(null));

describe("listing", () => {
  test("advertises exactly the four tools, all named in the catalogue write list", async () => {
    const names = (await listTools()).map((tool) => tool.name);
    expect(names).toEqual([
      "add_mcp_server",
      "install_skill",
      "add_custom_provider",
      "add_agent",
    ]);
  });
});

describe("the gate", () => {
  test("an unattributed run is refused before anything else", async () => {
    usePlatformTools(stub().tools);
    const result = await callTool({ url: "builtin://platform-tools" }, "add_mcp_server", {
      name: "x",
      url: "https://x.test/mcp",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not attributed to anybody");
  });

  test("a non-administrator is refused and no store is touched", async () => {
    const { tools, calls } = stub({ actorIsAdmin: async () => false });
    usePlatformTools(tools);
    const result = await callTool(CONNECTION, "add_custom_provider", {
      id: "9router",
      label: "9router",
      base_url: "https://ninerouter-vzw3.onrender.com/v1",
      key_variable: "NINEROUTER_API_KEY",
      default_model: "auto:default",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Only an administrator");
    expect(calls).toEqual([]);
  });

  test("with nothing installed, the tools say so", async () => {
    const result = await callTool(CONNECTION, "add_mcp_server", {
      name: "x",
      url: "https://x.test/mcp",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not available in this deployment");
  });
});

describe("add_mcp_server", () => {
  test("dispatches to the store path with the title defaulted from the name", async () => {
    const { tools, calls } = stub();
    usePlatformTools(tools);
    const result = await callTool(CONNECTION, "add_mcp_server", {
      name: "weather",
      url: "https://weather.test/mcp",
      auth_env_variable: "WEATHER_TOKEN",
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("weather is added");
    expect(calls).toEqual([
      {
        method: "addMcpServer",
        input: {
          id: "weather",
          title: "weather",
          url: "https://weather.test/mcp",
          authEnvVariable: "WEATHER_TOKEN",
        },
      },
    ]);
  });

  test("credential id and env variable together are refused", async () => {
    const { tools, calls } = stub();
    usePlatformTools(tools);
    const result = await callTool(CONNECTION, "add_mcp_server", {
      name: "weather",
      url: "https://weather.test/mcp",
      credential_id: "cred-1",
      auth_env_variable: "WEATHER_TOKEN",
    });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  test("a store refusal is carried through verbatim", async () => {
    const { tools } = stub({
      addMcpServer: async () => {
        throw new Error("That address is on this deployment's own network.");
      },
    });
    usePlatformTools(tools);
    const result = await callTool(CONNECTION, "add_mcp_server", {
      name: "weather",
      url: "https://weather.test/mcp",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("on this deployment's own network");
  });
});

describe("install_skill", () => {
  test("wraps SKILL.md markdown into slug/title/summary/instructions", async () => {
    const { tools, calls } = stub();
    usePlatformTools(tools);
    const markdown = [
      "---",
      "name: Release Notes",
      "description: Drafts release notes from merged PRs.",
      "---",
      "# Release Notes",
      "",
      "Read the merged pull requests and draft the notes.",
    ].join("\n");
    const result = await callTool(CONNECTION, "install_skill", { markdown });
    expect(result.isError).toBe(false);
    expect(calls).toEqual([
      {
        method: "installSkill",
        input: {
          slug: "release-notes",
          title: "Release Notes",
          summary: "Drafts release notes from merged PRs.",
          instructions: "# Release Notes\n\nRead the merged pull requests and draft the notes.",
          ownerUserId: "admin-1",
        },
      },
    ]);
  });

  test("global installs for the deployment (null owner)", async () => {
    const { tools, calls } = stub();
    usePlatformTools(tools);
    await callTool(CONNECTION, "install_skill", {
      name: "Triage",
      markdown: "# Triage\n\nSort the inbox.",
      global: true,
    });
    expect(calls[0].input).toMatchObject({ slug: "triage", ownerUserId: null });
  });

  test("no markdown and no source is a refusal, not an empty skill", async () => {
    const { tools, calls } = stub();
    usePlatformTools(tools);
    const result = await callTool(CONNECTION, "install_skill", { name: "Empty" });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("add_custom_provider", () => {
  test("dispatches the row and reports where it landed and the restart caveat", async () => {
    const { tools, calls } = stub();
    usePlatformTools(tools);
    const result = await callTool(CONNECTION, "add_custom_provider", {
      id: "9router",
      label: "9router",
      base_url: "https://ninerouter-vzw3.onrender.com/v1",
      key_variable: "NINEROUTER_API_KEY",
      default_model: "auto:default",
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("/deploy/providers.local.json");
    expect(result.text).toContain("BOT_PROVIDER=9router");
    expect(calls).toEqual([
      {
        method: "addCustomProvider",
        input: {
          id: "9router",
          label: "9router",
          baseUrl: "https://ninerouter-vzw3.onrender.com/v1",
          keyVariable: "NINEROUTER_API_KEY",
          defaultModel: "auto:default",
        },
      },
    ]);
  });

  test("a missing field is refused before the store", async () => {
    const { tools, calls } = stub();
    usePlatformTools(tools);
    const result = await callTool(CONNECTION, "add_custom_provider", {
      id: "9router",
      label: "9router",
    });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("add_agent", () => {
  test("creates the coworker with grants and private visibility by default", async () => {
    const { tools, calls } = stub();
    usePlatformTools(tools);
    const result = await callTool(CONNECTION, "add_agent", {
      name: "Researcher",
      role: "Searches the web and writes cited briefs.",
      grants: ["platform-tools"],
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Researcher is created");
    expect(calls).toEqual([
      {
        method: "addAgent",
        input: {
          name: "Researcher",
          title: "Researcher",
          role: "Searches the web and writes cited briefs.",
          visibility: "private",
          grants: ["platform-tools"],
        },
      },
    ]);
  });

  test("an unregistered provider is refused before creation", async () => {
    const { tools, calls } = stub();
    usePlatformTools(tools);
    const result = await callTool(CONNECTION, "add_agent", {
      name: "Researcher",
      role: "Searches.",
      provider: "nope-router",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("no provider registered");
    expect(calls).toEqual([]);
  });
});

describe("SKILL.md parsing", () => {
  test("frontmatter wins; the heading is the fallback title", () => {
    expect(parseSkillMarkdown("# Just A Heading\n\nBody text.")).toMatchObject({
      title: "Just A Heading",
      summary: "Body text.",
      instructions: "# Just A Heading\n\nBody text.",
    });
    expect(slugify("Release Notes!")).toBe("release-notes");
    expect(slugify("  --Already--Slugged--  ")).toBe("already-slugged");
  });
});
