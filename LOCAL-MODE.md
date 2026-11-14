# OpenBot Local Mode (no CopilotKit Intelligence)

Local mode is a fork patch on top of upstream OpenBot v0.2.0. It lets the
server boot and chat **without a CopilotKit Intelligence project, API key, or
license** — no `INTELLIGENCE_*` variable is required or read.

Upstream behaviour is unchanged unless the switch is on.

## Run it

```bash
OPENBOT_LOCAL_MODE=true
DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot
KEY_ENCRYPTION_KEY=<base64 32 bytes: openssl rand -base64 32>
OPENBOT_SINGLE_USER=true            # typical for a personal deployment
OPENAI_API_KEY=<your model key>     # or another configured provider
# OPENAI_BASE_URL=https://your-openai-compatible-endpoint/v1   # e.g. a local router
# BOT_MODEL=<model name>
```

`OPENBOT_LOCAL_MODE` accepts `true` or `1`; anything else is off.
Leave every `INTELLIGENCE_*` / `CPK_INTELLIGENCE_*` variable unset.

## How it works

- `server/src/config.ts` — `runtimeCapabilities()` returns
  `{ mode: "local", durableHistory: false }` when the switch is on, instead of
  throwing for missing `INTELLIGENCE_*` values.
- `server/src/copilot.ts` — `mountCopilotRuntime()` builds `CopilotRuntime`
  with `runner: new InMemoryAgentRunner()` (SSE mode of
  `@copilotkit/runtime` 1.77.0) instead of `intelligence`. The runtime handler
  serves thread history from that runner, so the web chat works end to end.
- `server/src/local-intelligence.ts` — a small stand-in for the direct
  Intelligence client calls on the headless paths (history reads, thread
  existence, thread locks), backed by the same process-global in-memory
  runner store. Thread locks are an in-process map.
- `server/src/index.ts` — routines/responsibilities/proactive/wake-up/group
  headless turns drive that in-process runner instead of the Intelligence
  runner WebSocket; bot-to-bot handoff deliveries use the runtime's local
  runner; the self-host banner is disabled (there is no entitlement to ask).
- `server/src/app.ts` — `/api/capabilities` reports `mode: "local"` and
  `durableHistory: false`; the `/api/threads/:id` Intelligence status check
  is not mounted (no reader), while `POST /api/threads/mint` still works.

## What works

- Booting with zero Intelligence configuration.
- Web chat (single user or signed-in), including history restore within the
  life of the process: the frontend's join/history flow degrades gracefully,
  and the server handler answers `GET /api/copilotkit/threads/:id/messages`
  from the in-memory runner.
- Headless turns — routines, responsibilities, proactive, wake-ups, group
  conversations, approvals continuation, handoffs — run in-process against
  the shared in-memory thread store.
- Everything unrelated to Intelligence: Postgres-backed channels, agents,
  credentials, computer gateway, audit, plugins.

## What is degraded

- **Thread history is not durable.** It lives in process memory only:
  a restart, redeploy, or second replica loses/forks every conversation.
  Single-instance deployments only.
- **Memory / Automatic Learning are off.** No Intelligence project means no
  learning containers, learned skills, or personal-memory sync through
  Intelligence (`copilotRuntime.learning` is undefined in local mode).
- **No cross-device realtime sync.** There is no Intelligence gateway
  WebSocket; other devices see updates on reload/history refresh, not live.
- **Thread status check is absent.** `GET /api/threads/:id` (does Intelligence
  still have this thread?) is not mounted; the browser simply proceeds.
- **Self-host banner is off**, since it exists to sell Intelligence
  self-hosting help and reads an Intelligence entitlement.
- The in-memory runner is bounded (the SDK evicts old thread history under
  memory pressure by design).

## Also in this fork: custom providers, skills, MCP servers, coworkers

Local mode changes how the runtime mounts; everything else in this fork works the same in
both modes. Custom model providers are registered as data (an overlay both provider loaders
read — `CUSTOM_PROVIDERS_JSON`, the Postgres `custom_providers` table, or
`providers.local.json`), and a built-in **Platform Tools**
server lets an administrator grant a Bot four governed write tools — `add_mcp_server`,
`install_skill`, `add_custom_provider`, `add_agent` — so all of it can also be done by asking
the Bot in chat. See **FEATURES.md** for the plain steps, exact env names and grant flow.

## Verification performed for this patch

- `bun install` (root workspace) — ok.
- `bun run typecheck` in `server/` — passes.
- Existing tests: config, copilot, learning-handoff, thread-status,
  thread-history, routine-run-turn, health, config-github-app —
  275 pass / 0 fail.
- Config boot gate: `loadConfig` with `OPENBOT_LOCAL_MODE=true` and no
  `INTELLIGENCE_*` vars returns `{ mode: "local", durableHistory: false }`;
  without the switch the same environment still refuses with
  "CopilotKit Intelligence is required…".
- Runtime mount probe: `mountCopilotRuntime` in local mode constructs,
  thread lock acquire/renew/release work, history reads return empty, and
  the mounted handler answers thread-messages with `200 {"messages":[]}`.
- Not yet verified: a full server boot against a real Postgres and a live
  model-backed chat turn (no Postgres/pgvector or model key in the build VM).
