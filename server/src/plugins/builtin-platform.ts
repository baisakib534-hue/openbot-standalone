import { cutAtCodeUnits } from "../channels/text";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

/**
 * The builtin transport for Platform Tools: a Bot changing the deployment it runs in — adding an
 * MCP server, installing a skill, registering a custom model provider, creating a coworker —
 * without leaving the building.
 *
 * LIKE ROUTINES, THERE IS NO VENDOR. The call runs against this deployment's own stores, through
 * the very methods the administrator's screens call (`PluginStore.addCustomServer`,
 * `PluginStore.installSkill`, the agent profile store's `create`, and the providers overlay the
 * model-provider loaders read). Nothing here is a side door: this module is reached only through
 * `PluginStore.callTool`, which checks the Bot's grant, classifies the call (all four tools are in
 * the catalogue entry's `writeTools`, so each is a WRITE), runs the policy engine and the approval
 * gate, and writes the audit row before the call is made.
 *
 * UNLIKE ROUTINES, THE ACTOR IS NOT SCOPE ENOUGH. A routine is the actor's own; these tools change
 * what EVERY Bot in the deployment can reach. So the actor read off the connection must be a
 * deployment administrator, checked here on every call through {@link PlatformTools.actorIsAdmin}
 * — the same fact `requireAdmin` checks on the HTTP routes these stores sit behind. A grant given
 * to a Bot whose owner is not an administrator buys nothing.
 *
 * It implements the same interface as the other transports, as module-level exports, because that
 * is the shape {@link ./transport} resolves: a `TransportKind` maps to a MODULE. The stores arrive
 * through {@link usePlatformTools} rather than through a constructor — see the comment there.
 */

/** What one add-custom-provider call resolved to, in words the result can repeat. */
export type CustomProviderOutcome = {
  id: string;
  /** Where the overlay row was written, so the answer can name the store that now holds it. */
  path: string;
};

export type PlatformTools = {
  /** Whether this person administers the deployment — the gate every tool below stands behind. */
  actorIsAdmin(actorId: string): Promise<boolean>;
  /** The actor's email, which is what the stores record as `by` on the rows they write. */
  actorEmail(actorId: string): Promise<string>;
  /**
   * Register a custom MCP server, through `PluginStore.addCustomServer` — the store method the
   * administrator's "Add by URL" route calls, URL checks and credential-kind check included.
   * `authEnvVariable` names an environment variable whose value is first stored as an `mcp`
   * credential through the credential admin service (the Credentials page's own path), and the
   * resulting credential id is what the server row points at. The value itself never appears in
   * the arguments a model sees twice or in any result.
   */
  addMcpServer(
    actorId: string,
    input: {
      id: string;
      title: string;
      url: string;
      credentialId?: string;
      authEnvVariable?: string;
    },
  ): Promise<{ id: string; title: string; toolCount: number }>;
  /**
   * Install a skill, through `PluginStore.installSkill` — the store method the Plugins page's
   * skill form posts to. `ownerUserId` null writes a deployment skill; the actor's own id writes
   * their personal one.
   */
  installSkill(
    actorId: string,
    input: {
      slug: string;
      title: string;
      summary: string;
      instructions: string;
      ownerUserId: string | null;
      tools?: string[];
    },
  ): Promise<{ slug: string }>;
  /**
   * Append one provider to the overlay store the model-provider loaders read
   * (`upsertCustomProviderFile` in shared/model-providers). Validation is the loaders' own, so a
   * row written here is a row both loaders accept.
   */
  addCustomProvider(input: {
    id: string;
    label: string;
    baseUrl: string;
    keyVariable: string;
    defaultModel: string;
  }): Promise<CustomProviderOutcome>;
  /** Whether a provider id is registered — a built-in, or an overlay row the loaders accepted. */
  providerExists(id: string): boolean;
  /**
   * Create a coworker through the agent profile store's `create` — the method POST /api/agents
   * calls — with no endpoint, so it runs in-server as a built-in Bot on the role text. `grants`
   * names MCP servers to grant the new Bot through `PluginStore.grant`, the grants table's own
   * write path.
   */
  addAgent(
    actorId: string,
    input: {
      name: string;
      title: string;
      role: string;
      visibility: "public" | "private";
      grants: string[];
    },
  ): Promise<{ id: string; name: string }>;
};

let installed: PlatformTools | null = null;

/**
 * Hand this module its stores, once, from the place that builds stores. Mirrors
 * {@link useRoutineTools} in ./builtin-routines, for the same reason: `transportFor` resolves a
 * kind to a MODULE and there is no seam to pass anything through. `null` is a supported argument
 * so a test can take its stub back out again.
 */
export function usePlatformTools(tools: PlatformTools | null): void {
  installed = tools;
}

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "add_mcp_server",
    description: [
      "Register a custom MCP server with this deployment, so Bots can be granted its tools.",
      "This is the same act as an administrator adding a server by URL on the Plugins page: the URL",
      "passes the deployment's checks, the server's tools are listed immediately, and a refusal from",
      "those checks comes back word for word. Registering a server grants it to NO Bot — a grant is",
      "a separate, deliberate step on the Plugins page.",
      "",
      "Give `name` as the server's id: lower-case letters, numbers and hyphens. If the server needs",
      "a bearer token, either pass `credential_id` for a credential already stored on the",
      "Credentials page, or `auth_env_variable` naming the environment variable that holds the",
      "token — its value is stored as a credential and never repeated back. Pass at most one.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The server's id: lower-case letters, numbers and hyphens.",
        },
        title: {
          type: "string",
          description: "The name people see. Defaults to the id when omitted.",
        },
        url: { type: "string", description: "The MCP server's URL." },
        credential_id: {
          type: "string",
          description: "A stored credential id (kind mcp) to reach the server with.",
        },
        auth_env_variable: {
          type: "string",
          description:
            "The name of an environment variable holding the server's token; it is stored as a credential.",
        },
      },
      required: ["name", "url"],
    },
  },
  {
    name: "install_skill",
    description: [
      "Install a skill: instructions a Bot follows when a task matches them. This is the same act",
      "as saving a skill on the Plugins page. A skill is an instruction, not a capability — it may",
      "name tools it needs, and naming one grants nothing; each call a skill leads to is still",
      "granted, policy-checked and audited on its own.",
      "",
      "Give the skill as SKILL.md-style markdown in `markdown`: an optional frontmatter block",
      "(`name:`, `title:`, `description:` between --- lines), a `# Title` heading, then the",
      "instructions. Or give `source_url` and the markdown is fetched from there. The skill's slug",
      "comes from `name` or the frontmatter name. It is installed as the skill of the person you",
      "are talking to, unless `global` is true, which writes one for the whole deployment.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The skill's name; its slug is derived from it." },
        markdown: { type: "string", description: "The skill, as SKILL.md-style markdown." },
        source_url: {
          type: "string",
          description: "A URL to fetch the markdown from, instead of passing it.",
        },
        global: {
          type: "boolean",
          description: "True writes a skill for the whole deployment rather than one person's.",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description:
            "Tools the skill needs, as serverId/toolName references. Naming one grants nothing.",
        },
      },
      required: [],
    },
  },
  {
    name: "add_custom_provider",
    description: [
      "Register a custom OpenAI-compatible model provider, as data: an id, the endpoint it answers",
      "on, the environment variable its API key arrives in, and a default model. This appends one",
      "row to the provider overlay both model-provider loaders read (the file CUSTOM_PROVIDERS_PATH",
      "names, or providers.local.json beside the provider spec), so no code changes and both the",
      "TypeScript and Python loaders see it. The key itself is never an argument — only the NAME of",
      "the variable holding it.",
      "",
      "The running server reads the overlay when it starts, so the new provider can be selected",
      "(BOT_PROVIDER=<id>) from the next start; say so when you report it added.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The provider's id, e.g. 9router: lower-case letters, digits, hyphens.",
        },
        label: { type: "string", description: "The name people see, e.g. 9router." },
        base_url: {
          type: "string",
          description: "The endpoint, e.g. https://ninerouter-vzw3.onrender.com/v1.",
        },
        key_variable: {
          type: "string",
          description: "The environment variable the API key arrives in, e.g. NINEROUTER_API_KEY.",
        },
        default_model: {
          type: "string",
          description: "The model Bots get when none is named, e.g. auto:default.",
        },
      },
      required: ["id", "label", "base_url", "key_variable", "default_model"],
    },
  },
  {
    name: "add_agent",
    description: [
      "Create a coworker: a new Bot that runs in this deployment, on the role you describe. This is",
      "the same act as adding a coworker on the Team page with no endpoint — the role text becomes",
      "its standing instruction, and it can be talked to as soon as it exists.",
      "",
      "A coworker runs on the deployment's own model: which provider and model that is belongs to",
      "the deployment (BOT_PROVIDER / BOT_MODEL and the provider registry), not to one coworker, so",
      "there is no per-agent model field. If `provider` is given it is checked against the registry",
      "and reported back, not stored on the agent. `grants` names MCP servers the new Bot is given",
      "straight away, through the same grants table the Plugins page writes.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The coworker's name." },
        role: {
          type: "string",
          description: "What this coworker does and how it works: its standing instruction.",
        },
        title: { type: "string", description: "Its job title. Defaults to its name." },
        visibility: {
          type: "string",
          description: "`private` (default) or `public` — public means everybody here may use it.",
        },
        provider: {
          type: "string",
          description: "Optional: a registered provider id to check against the registry.",
        },
        model: { type: "string", description: "Optional: a model name to report alongside it." },
        grants: {
          type: "array",
          items: { type: "string" },
          description: "MCP server ids to grant the new Bot immediately.",
        },
      },
      required: ["name", "role"],
    },
  },
]);

export async function listTools(): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

export const listNeedsCredential = false;

const failure = (message: string): McpCallResult => ({
  text: message,
  isError: true,
  truncated: false,
});

/** Success as a result, with the same visible cap the vendor transports use. */
function asResult(text: string): McpCallResult {
  if (text.length <= MAX_RESULT_CHARS) {
    return { text, isError: false, truncated: false };
  }
  return {
    text: `${cutAtCodeUnits(text, MAX_RESULT_CHARS)}\n\n[truncated: the tool returned ${text.length} characters]`,
    isError: false,
    truncated: true,
  };
}

/** A string argument that was actually given, or nothing. Blank is not a value. */
function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function stringListArg(
  args: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) return undefined;
  const list = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return list;
}

/** The slug a skill or server id must match, the same rule the HTTP routes enforce. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

/** A name as a slug: lower-case, runs of anything else become one hyphen, edges trimmed. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export type ParsedSkillMarkdown = {
  slug?: string;
  title?: string;
  summary: string;
  instructions: string;
};

/**
 * A SKILL.md-style document, taken apart into the fields the skill store holds.
 *
 * The store's shape is slug/title/summary/instructions; the document's shape is a frontmatter
 * block, a heading and a body. Frontmatter `name` names the slug, `title` the title and
 * `description` the summary; without frontmatter the first `# ` heading is the title and the
 * first paragraph under it the summary. The instructions are the document with the frontmatter
 * removed — the heading stays, because it is part of how the skill reads to the Bot that follows
 * it. Pure and exported so the wrapping is testable without a store.
 */
export function parseSkillMarkdown(markdown: string): ParsedSkillMarkdown {
  let body = markdown.trim();
  const frontmatter: Record<string, string> = {};
  const fence = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fence) {
    for (const line of fence[1].split(/\r?\n/)) {
      const pair = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
      if (pair) frontmatter[pair[1].toLowerCase()] = pair[2].trim().replace(/^["']|["']$/g, "");
    }
    body = body.slice(fence[0].length).trim();
  }
  const heading = body.match(/^#\s+(.+)$/m);
  const title = frontmatter.title || (heading ? heading[1].trim() : undefined);
  const firstParagraph = body
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith("#"))
    .map((part) => part.replace(/\s*\n\s*/g, " "))
    .find((part) => part.length > 0);
  return {
    slug: frontmatter.name ? slugify(frontmatter.name) : undefined,
    title,
    summary: frontmatter.description || frontmatter.summary || firstParagraph || "",
    instructions: body,
  };
}

type Connection = {
  url: string;
  token?: string;
  actorId?: string;
  botId?: string;
};

/** The largest skill document a fetch may bring in; a skill is instructions, not an archive. */
const MAX_SKILL_FETCH_CHARS = 1_000_000;

/**
 * Call one tool.
 *
 * WHOSE ACT THIS IS COMES FROM THE CONNECTION, NEVER FROM `args` — the same rule as Routines, for
 * the same reason, with one addition: the actor must administer this deployment. Both facts are
 * settled before any store is touched, and nothing a model puts in the arguments can stand in for
 * either. Refusals from the stores are carried through verbatim, as they are in Routines: they are
 * written for a model to act on.
 */
export async function callTool(
  connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const actorId = connection.actorId?.trim();
  if (!actorId) {
    return failure(
      "Changing this deployment belongs to somebody, and this run is not attributed to anybody.",
    );
  }
  const agentId = connection.botId?.trim();
  if (!agentId) {
    return failure("These tools run as a Bot, and this run does not name one.");
  }
  const tools = installed;
  if (!tools) {
    return failure("Platform Tools is not available in this deployment.");
  }
  let isAdmin = false;
  try {
    isAdmin = await tools.actorIsAdmin(actorId);
  } catch {
    isAdmin = false;
  }
  if (!isAdmin) {
    return failure(
      "Only an administrator can change this deployment — add servers, install skills, register providers or create coworkers. Ask an administrator to do it, or to make you one.",
    );
  }

  try {
    if (toolName === "add_mcp_server") {
      const name = stringArg(args, "name");
      if (!name) return failure("A server needs a name: lower-case letters, numbers and hyphens.");
      const url = stringArg(args, "url");
      if (!url) return failure("A server needs its URL.");
      const credentialId = stringArg(args, "credential_id");
      const authEnvVariable = stringArg(args, "auth_env_variable");
      if (credentialId && authEnvVariable) {
        return failure("Give either a stored credential or an environment variable, not both.");
      }
      const server = await tools.addMcpServer(actorId, {
        id: name,
        title: stringArg(args, "title") ?? name,
        url,
        ...(credentialId ? { credentialId } : {}),
        ...(authEnvVariable ? { authEnvVariable } : {}),
      });
      return asResult(
        `${server.title} is added (id: ${server.id}) and its ${server.toolCount} tool${server.toolCount === 1 ? "" : "s"} are listed. No Bot has been given it yet — grant it on the Plugins page before a Bot can call it.`,
      );
    }

    if (toolName === "install_skill") {
      let markdown = stringArg(args, "markdown");
      const sourceUrl = stringArg(args, "source_url");
      if (!markdown && sourceUrl) {
        let parsed: URL;
        try {
          parsed = new URL(sourceUrl);
        } catch {
          return failure("That source is not a URL I can fetch.");
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return failure("A skill's source must be an http or https URL.");
        }
        const response = await fetch(parsed, { redirect: "follow" });
        if (!response.ok) {
          return failure(`Fetching that skill failed: HTTP ${response.status}.`);
        }
        markdown = (await response.text()).slice(0, MAX_SKILL_FETCH_CHARS);
      }
      if (!markdown) {
        return failure("A skill needs its markdown: pass `markdown`, or a `source_url` to fetch it from.");
      }
      const parsedSkill = parseSkillMarkdown(markdown);
      const slug = slugify(stringArg(args, "name") ?? parsedSkill.slug ?? parsedSkill.title ?? "");
      if (!SLUG_PATTERN.test(slug)) {
        return failure("A skill needs a name I can make a slug from: letters, numbers and hyphens.");
      }
      const title = parsedSkill.title ?? slug;
      const global = args.global === true;
      const declaredTools = stringListArg(args, "tools");
      const result = await tools.installSkill(actorId, {
        slug,
        title,
        summary: parsedSkill.summary,
        instructions: parsedSkill.instructions,
        ownerUserId: global ? null : actorId,
        ...(declaredTools === undefined ? {} : { tools: declaredTools }),
      });
      return asResult(
        `The skill "${title}" is installed (slug: ${result.slug})${global ? " for the whole deployment" : ""}. A Bot uses it once it is granted the skill, and any tools it names still need their own grants.`,
      );
    }

    if (toolName === "add_custom_provider") {
      const id = stringArg(args, "id");
      const label = stringArg(args, "label");
      const baseUrl = stringArg(args, "base_url");
      const keyVariable = stringArg(args, "key_variable");
      const defaultModel = stringArg(args, "default_model");
      if (!id || !label || !baseUrl || !keyVariable || !defaultModel) {
        return failure(
          "A provider needs an id, a label, a base_url, the key_variable its key arrives in, and a default_model.",
        );
      }
      const outcome = await tools.addCustomProvider({
        id,
        label,
        baseUrl,
        keyVariable,
        defaultModel,
      });
      return asResult(
        `${label} is registered as provider "${outcome.id}" in ${outcome.path}. Both loaders accept it from the next server start, and Bots can then be pointed at it with BOT_PROVIDER=${outcome.id}. Its key is read from ${keyVariable} — make sure that variable is set in the deployment's environment.`,
      );
    }

    if (toolName === "add_agent") {
      const name = stringArg(args, "name");
      if (!name) return failure("A coworker needs a name.");
      const role = stringArg(args, "role");
      if (!role) return failure("A coworker needs its role: what it does and how it works.");
      const visibility = stringArg(args, "visibility");
      if (visibility !== undefined && visibility !== "public" && visibility !== "private") {
        return failure("Visibility is `private` or `public`.");
      }
      const grants = stringListArg(args, "grants") ?? [];
      const namedProvider = stringArg(args, "provider");
      if (namedProvider && !tools.providerExists(namedProvider.toLowerCase())) {
        return failure(
          `There is no provider registered as "${namedProvider}". Register it first with add_custom_provider, then create the coworker.`,
        );
      }
      const agent = await tools.addAgent(actorId, {
        name,
        title: stringArg(args, "title") ?? name,
        role,
        visibility: visibility === "public" ? "public" : "private",
        grants,
      });
      const model = stringArg(args, "model");
      const modelNote =
        namedProvider || model
          ? ` It runs on the deployment's model like every coworker${namedProvider ? `; "${namedProvider}" is registered, and selecting it is the deployment's BOT_PROVIDER setting, not one agent's field` : ""}.`
          : "";
      const grantNote =
        grants.length > 0
          ? ` It has been granted: ${grants.join(", ")}.`
          : " It has no tool grants yet — grant them on the Plugins page.";
      return asResult(
        `${agent.name} is created (id: ${agent.id}) and can be talked to now.${grantNote}${modelNote}`,
      );
    }

    return failure(
      `${toolName} is not a tool Platform Tools implements. The stored tool list is out of date; refresh it on the Plugins page.`,
    );
  } catch (error) {
    // The store's sentence, unchanged, capped as Routines caps its refusals.
    const message = error instanceof Error ? error.message : String(error);
    return failure(Array.from(message).slice(0, 2_000).join(""));
  }
}
