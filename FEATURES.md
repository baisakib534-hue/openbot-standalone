# Features: custom providers, MCP servers, skills, and coworkers — by hand or by asking the Bot

Everything in this guide can be done two ways: by an administrator in the app or the
environment, or **by asking the Bot in chat**, once the Bot holds the Platform Tools grant
([§4](#4-platform-tools-asking-the-bot-to-do-it)). Both ways land in the same stores, pass the
same checks, and leave the same audit trail. This works in local mode
(`OPENBOT_LOCAL_MODE=true`) exactly as it does upstream.

## 1. Add a custom model provider

A custom provider is any OpenAI-compatible endpoint (a router like 9router, a gateway, a local
server) registered **as data** — no code edit, no rebuild of the loaders. Both provider loaders
(the TypeScript one and the Python one) read the same overlay, so a provider registered once is
visible to every Bot.

Each provider row has:

| Field | Meaning | Example |
|---|---|---|
| `label` | Name people see | `9router` |
| `base_url` | The endpoint | `https://ninerouter-vzw3.onrender.com/v1` |
| `key_variable` | Env var the API key arrives in (never the key itself) | `NINEROUTER_API_KEY` |
| `default_model` | Model Bots get when none is named | `auto:default` |
| `api` | Always `"chat"` (OpenAI-compatible chat completions) | `chat` |
| `base_url_variable` | Optional: env var that may override `base_url`. Derived from the id when omitted | `PROVIDER_9ROUTER_BASE_URL` |

### Way A — environment variable

Set `CUSTOM_PROVIDERS_JSON` to the overlay as JSON, and the key itself as its own variable:

```bash
CUSTOM_PROVIDERS_JSON={"providers":{"9router":{"label":"9router","base_url":"https://ninerouter-vzw3.onrender.com/v1","key_variable":"NINEROUTER_API_KEY","default_model":"auto:default","api":"chat"}},"bots":{}}
NINEROUTER_API_KEY=<your key, as a secret>
BOT_PROVIDER=9router        # select it for the built-in Bots
# BOT_MODEL=combo:top       # optional: override its default model
```

### Way B — a file

Copy `shared/providers.local.example.json` to `providers.local.json` (same folder) and edit —
it ships with 9router and FreeLLMAPI worked examples. To keep the file somewhere durable (a
mounted volume), point `CUSTOM_PROVIDERS_PATH` at it. When both sources name the same id, the
environment JSON wins. An optional `"bots"` section in the overlay can point a named Bot at a
custom provider, e.g. `"bots": {"agent-langgraph": {"provider": "9router", "model": "auto:default"}}`.

### Way C — ask the Bot

With Platform Tools granted (§4): *"Add 9router as a provider: base URL
https://ninerouter-vzw3.onrender.com/v1, key in NINEROUTER_API_KEY, default model
auto:default."* The Bot calls `add_custom_provider`, which appends the row to the overlay file
(the `CUSTOM_PROVIDERS_PATH` file when set). Loaders read the overlay at startup, so the
provider is selectable from the **next server start** — set `BOT_PROVIDER=9router` and restart.

## 2. Add an MCP server

### Admin path

Plugins page → **Add by URL**: give a name (the server's id: lower-case letters, numbers,
hyphens), a title, and the URL. The deployment's URL checks run (no private/own-network
addresses unless the deployment explicitly allows them), and the server's tools are listed
immediately. If the server needs a bearer token, first store it on the **Credentials** page
(kind `mcp`), then pass that credential when adding the server. Adding a server grants it to
**no** Bot — grant it per Bot on the Plugins page.

### Ask the Bot

*"Add this MCP server: name `weather`, URL https://weather.example/mcp, token in the
WEATHER_TOKEN environment variable."* The Bot calls `add_mcp_server` — the same store method,
the same URL checks. Instead of an environment variable it can take a stored `credential_id`.
The token's value is stored as an `mcp` credential; it never appears in chat or results.

## 3. Install a skill

A skill is instructions a Bot follows when a task matches — it is not a capability: a skill may
name tools it needs, and naming one grants nothing.

### Admin path

Plugins page → skill form: slug, title, summary, instructions, and optionally the tool refs it
needs (`serverId/toolName`). A person's skill is their own; an administrator can also write one
for the whole deployment.

### Ask the Bot

*"Install this skill:"* followed by SKILL.md-style markdown — or *"Install the skill at
https://…/SKILL.md"*. The Bot calls `install_skill`, which accepts:

- an optional frontmatter block (`name:`, `title:`, `description:` between `---` lines),
- a `# Title` heading,
- the instructions as the body.

The slug is derived from the name. By default the skill belongs to the person talking; with
"for the whole deployment" it is installed globally (the caller must be an administrator —
see §4).

## 4. Platform Tools: asking the Bot to do it

**Platform Tools** is a built-in server in the catalogue (like Routines) with four tools, all
classified as **writes**:

| Tool | What it does | Same store path as |
|---|---|---|
| `add_mcp_server` | Register a custom MCP server | Plugins page → Add by URL |
| `install_skill` | Create a personal or deployment skill | Plugins page → skill form |
| `add_custom_provider` | Append a provider to the overlay file | Editing `providers.local.json` |
| `add_agent` | Create a coworker, optionally with tool grants | Team page → Add coworker (no endpoint) |

### Grant it to your Bot (once, administrator)

1. Sign in as an administrator and open the **Plugins** page.
2. Add the **Platform Tools** server from the catalogue (it dials nothing — it is built in).
3. Grant **Platform Tools** to the Bot you want to do these things (the same grant control as
   any other server).

### The rules that still apply

- **Grant required.** A Bot without the Platform Tools grant cannot call these tools at all —
  the call never reaches them.
- **Administrator required.** The person talking to the Bot must be a deployment administrator
  (in single-user local mode, that is you). The tools refuse anybody else, even with a grant.
- **Approval + audit.** Every call is a write: it goes through the policy engine and the
  approval gate like any other write, and lands in the audit trail (server adds, skill
  installs, credential creations, bot creations) before it runs.
- Nothing here is a side door: each tool calls the exact store method the admin screens call,
  refusals included — a bad URL, an unknown tool ref in a skill, or a provider row the loaders
  would reject all come back as the store's own sentence.

### Example asks

- *"Add 9router as a provider — base URL https://ninerouter-vzw3.onrender.com/v1, key variable
  NINEROUTER_API_KEY, default model auto:default."*
- *"Add this MCP server: name `weather`, URL https://weather.example/mcp, token in
  WEATHER_TOKEN."*
- *"Install this skill …"* (paste SKILL.md markdown), or *"Install the skill at <URL> for the
  whole deployment."*
- *"Add a researcher agent that searches the web and writes cited briefs, and grant it the
  weather server."* → approval → the coworker exists and answers in chat straight away. A
  coworker runs on the deployment's model — provider/model are deployment settings
  (`BOT_PROVIDER`/`BOT_MODEL`), not per-agent fields; naming a provider in the ask makes the
  Bot check it is registered first.
