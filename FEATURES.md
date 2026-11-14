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

The overlay has three sources, in this precedence order: **`CUSTOM_PROVIDERS_JSON` (environment)
> the Postgres `custom_providers` table > the overlay file**. A dashboard-set environment row
always wins, a provider added from chat (the table) beats the file, and a built-in provider id
can never be redefined by any source. On every boot the server merges the three sources and
writes the result back to the overlay file, so the loaders in other processes — which cannot
read the server's database — see the database rows too.

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

### Way C — ask the Bot (durable, self-contained)

With Platform Tools granted (§4): *"Add 9router as a provider: base URL
https://ninerouter-vzw3.onrender.com/v1, default model auto:default, here is the API key: …"*
The Bot calls `add_custom_provider`, which stores the row in the **Postgres `custom_providers`
table** — not in a file on the server's disk — so the provider **survives restarts and
redeploys**, including on hosts with an ephemeral filesystem (e.g. Render's free tier), with
**zero dashboard or environment edits**. On the next boot the server merges the table into the
overlay and materializes it for both loaders automatically.

The key has two ways in:

- **Give the key itself** (`api_key` in the ask). It is stored **encrypted in the credential
  vault** — the same KEY_ENCRYPTION_KEY-backed store as every other credential — under
  coordinates derived from the provider id (kind `model`, provider `custom-provider`, keyId =
  the provider id). The plaintext never lands in the provider row, the overlay file, a log, or
  the tool result. `key_variable` may be omitted in this form; a fallback variable name is
  derived from the id (e.g. `PROVIDER_9ROUTER_API_KEY`). At call time, resolution reads the
  environment variable first when it holds a value, and the stored key otherwise.
- **Or name the variable** (`key_variable`, no key in chat) — the original behaviour, unchanged:
  the key is read from that environment variable only.

One honest limit: the provider is registered in the running server's registry immediately,
but the deployment's selected model is built at startup and is not switched mid-run — so the
provider becomes selectable (`BOT_PROVIDER=9router`) from the **next server start**. On hosts
that spin down when idle, that is simply the next natural wake; no redeploy is needed.

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
| `add_custom_provider` | Store a provider durably in Postgres; with a key, store it encrypted in the vault | The overlay sources in §1 (database row) |
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
  weather server."* → approval → the coworker exists and answers in chat straight away. Naming
  a server in the ask grants the new Bot every tool that server currently lists (grants are
  per tool underneath). A
  coworker runs on the deployment's model — provider/model are deployment settings
  (`BOT_PROVIDER`/`BOT_MODEL`), not per-agent fields; naming a provider in the ask makes the
  Bot check it is registered first.

## 5. Spaces — document workspaces (ported from OpenDots)

A **Space** is a small document workspace: a library of pages you and your Bots write
together. Open the **Spaces** entry in the sidebar (next to Skills).

- **Library.** Each Space lists its pages as cards (grid or list), with search across titles
  and content and sorting by recent edit or name. Pages can nest: a page's subpages show on
  the page itself, and deleting a page moves its subpages up one level rather than deleting
  them.
- **Editor.** Pages edit in a rich visual editor (headings, lists, checklists, quotes, code,
  tables, links, undo/redo, and a `/` slash menu for blocks) with a Markdown source mode one
  click away. Markdown is the stored source of truth; the editor's document state is kept
  alongside it. Edits autosave after a short pause.
- **Revision conflicts.** Every save carries the revision you started from. If the page
  changed underneath you — another tab, or a Bot edit — the save is refused with a conflict
  message and **your draft is kept**; load the latest version when you are ready to merge by
  hand. Nothing is silently overwritten.
- **Bot access (grants).** A Bot sees a Space only while it is ticked in the Space's **Bot
  access** panel. With a grant, the Bot gets five page tools in chat — `list_spaces`,
  `list_pages`, `read_page`, `create_page`, `update_page` — scoped to exactly the Spaces it
  was granted, checked again on every call. Revoke the tick and the tools stop seeing the
  Space immediately. Updates require the current revision, so a Bot can never clobber a
  newer edit either.
- **Page conversations.** Open a page and choose **Discuss**: pick a granted Bot and you get
  a conversation bound to that page. The Bot runs with the page's current content in its
  context (marked as material to work from, re-readable with `read_page`), so "tighten the
  second paragraph" just works. In local mode these threads run on the same local runner as
  every other chat.
- **Save a conversation as a page.** Inside a page conversation, **Save as page** writes the
  visible conversation into a new page in the same Space, stamped with where it came from.
- **Review before save.** When a Bot drafts a whole page in a page conversation, it asks
  first: a review card shows the proposed title and content, you approve or decline, and
  only an approval writes the page — exactly once, even if the request is retried. Declining
  tells the Bot not to save it.

There are no new environment variables for Spaces; everything is per-user data in the same
database, scoped to your account like Routines and skills.

### OpenDots → OpenBot audit (phase 2)

Every OpenDots feature, and where it landed:

| OpenDots feature | Verdict |
| --- | --- |
| Spaces, page library (grid/list, search, sort) | **Ported** — §5 above |
| Rich page editor (TipTap, slash commands, source mode) | **Ported** — same TipTap 3.x family, OpenBot chrome and theme tokens |
| Nested subpages, delete re-parents children | **Ported** |
| Autosave with revision check (409 on stale save) | **Ported** |
| Per-page conversations (page content as chat context) | **Ported** — page context rides the Bot's normal thread machinery, local mode included |
| Save conversation as page | **Ported** |
| Page review-before-save (approve/decline card, idempotent save) | **Ported** |
| Space access grants per Dot | **Ported** — mapped onto a per-Space Bot access panel and per-call grant checks |
| Specialist Dots (named helpers with instructions) | Already in OpenBot — coworkers/Bots (§4 creates them from chat) |
| Scheduled background work | Already in OpenBot — Routines (cron, quiet hours, pause/resume) |
| Managed channels (e.g. Slack) | Already in OpenBot — channels |
| Browser/computer work | Already in OpenBot — the computer gateway behind the hosted browser tools |
| Voice turns and spoken summaries | Already in OpenBot — voice sessions with written summaries |
| Memory / standing preferences | Already in OpenBot — personal memory and user instructions |
| Mascot artwork per Dot | Not ported — OpenDots' mascot PNGs are artwork for its own cast; OpenBot Bots already carry their own seeded avatars, and new artwork is a design task, not a code gap |
| TaskPresentation / ResultPane components | Not ported — presentational patterns tied to OpenDots' own task screens; OpenBot renders routine runs and tool results in its own surfaces |
| Automatic Learning from demonstrations | Not ported — it depends on hosted Intelligence recordings in OpenDots' design; OpenBot's learning exists in upstream mode only, and stays off in local mode on both sides |
