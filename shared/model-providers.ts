/**
 * The facts every Bot shares about the model providers it may be pointed at.
 *
 * One entry per provider, rather than the same default model, key variable and base URL variable
 * written out in each Bot. They were written out in each Bot, and they drifted: five files, five
 * different default OpenAI models, the first time somebody changed one of them in one place only.
 * A provider is added here; the Bots that speak its SDK take their names from this table.
 *
 * THE VALUES LIVE IN `model-providers.json`, beside this file. That file is the contract every
 * language in the box reads — TypeScript and Python through the loaders beside it, any other
 * language straight as JSON — so a developer adding a Bot in Java adds one entry there and never
 * reads this module. What the two loaders add to the file is types and validation: in either
 * loader, a row missing a field, a provider row the file lacks, a provider row that loader's list
 * has never heard of, or a `bots` entry naming a provider outside that list, stops the process at
 * startup with the path of the offending key rather than at the first model call.
 *
 * ENVIRONMENT BEATS FILE. `BOT_PROVIDER` and `BOT_MODEL` still win, exactly as
 * `docs/configuration.md` has always described; the file supplies what they leave unset. API keys
 * never appear in the file — they arrive in the environment under the `key_variable` the provider
 * row names.
 *
 * CUSTOM PROVIDERS ARE DATA TOO. A deployment may register extra OpenAI-compatible providers
 * without editing this module or the JSON: an overlay read from `CUSTOM_PROVIDERS_JSON` (an inline
 * JSON object) and/or a `providers.local.json` file beside `model-providers.json` (its path may be
 * named by `CUSTOM_PROVIDERS_PATH`). Each overlay row names an endpoint directly — `base_url`,
 * not a variable — plus the `key_variable` its key arrives in, a `default_model`, and an `api`
 * style (only `"chat"`, OpenAI-compatible chat completions, for now). Overlay rows are validated
 * with the same strictness as the base file, may not reuse a built-in id, and overlay `bots`
 * entries may name overlay providers. With no overlay configured, nothing changes: the registry
 * is exactly the three built-in rows, which is what the tests pin.
 *
 * Facts only. Which provider a Bot can DRIVE is that Bot's own decision, beside the code that
 * loads its SDK: this module knows Google exists and what its key is called, and `agent-mastra`
 * still refuses it because it loads no Google module. Keeping the two apart is what lets a new
 * provider be registered here without pretending every harness can answer for it. The `bots`
 * section records what a Bot runs by default, not what it is able to drive.
 *
 * Its own module for the reason `model-key.ts` had to be one: `agent-bot` and `agent-langgraph`
 * call `serve()` at module scope, so importing a pure function from an entry point binds a port.
 */

import specJson from "./model-providers.json";

/**
 * The providers this deployment knows the names of.
 *
 * Adding one is one entry here, one in `PROVIDER_IDS` in `shared/model_providers.py`, and one row
 * to the JSON file. Each loader checks the file against its own list in both directions, so a
 * provider row this list names and the file lacks, or a row in the file this list has never heard
 * of, stops this Bot at startup rather than at its first model call.
 */
export const PROVIDER_IDS = ["openai", "anthropic", "google"] as const;

export type ModelProviderId = (typeof PROVIDER_IDS)[number];

export type ProviderSpec = {
  /** A built-in id, or a custom provider's id from the overlay — hence a plain string. */
  readonly id: string;
  /** How the provider is named in an error message. */
  readonly label: string;
  /** The environment variable its API key arrives in. */
  readonly keyVariable: string;
  /** The environment variable an endpoint override for it arrives in. */
  readonly baseUrlVariable: string;
  /** What a Bot uses when it is told a provider and no model. */
  readonly defaultModel: string;
  /**
   * The endpoint itself, for a custom provider. Built-in rows name a variable instead, because
   * their endpoints are the vendor's own; a custom provider IS an endpoint, so the row carries it.
   */
  readonly baseUrl?: string;
  /**
   * How the endpoint is spoken to. Only `"chat"` (OpenAI-compatible chat completions) exists for
   * custom providers today; built-in rows leave it unset and are driven by their own SDKs.
   */
  readonly api?: string;
};

/** A row as `model-providers.json` writes it: snake_case, because every language reads it. */
type SpecProviderRow = {
  readonly label?: unknown;
  readonly key_variable?: unknown;
  readonly base_url_variable?: unknown;
  readonly default_model?: unknown;
};

/** What the file says a Bot runs when its environment names nothing. */
type SpecBotRow = {
  readonly provider?: unknown;
  readonly model?: unknown;
};

type SpecFile = {
  readonly providers?: Readonly<Record<string, SpecProviderRow | undefined>>;
  readonly bots?: Readonly<Record<string, SpecBotRow | undefined>>;
};

/** A custom-provider row as an overlay writes it: it names its endpoint, not a variable for one. */
type CustomProviderRow = {
  readonly label?: unknown;
  readonly base_url?: unknown;
  readonly key_variable?: unknown;
  readonly base_url_variable?: unknown;
  readonly default_model?: unknown;
  readonly api?: unknown;
};

type OverlayFile = {
  readonly providers?: Readonly<Record<string, CustomProviderRow | undefined>>;
  readonly bots?: Readonly<Record<string, SpecBotRow | undefined>>;
};

/** What one overlay source contributes, before sources are merged. */
export type CustomProvidersOverlay = {
  readonly providers: readonly ProviderSpec[];
  readonly bots: Readonly<Record<string, { provider: string; model: string }>>;
};

function failOverlay(source: string, problem: string): never {
  throw new Error(`${source}: ${problem}`);
}

/** Digits may lead: the canonical custom provider is `9router`, a name nobody gets to re-spell. */
const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const ENV_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Names an overlay id may not take: object-prototype members the registries already refuse. */
const RESERVED_PROVIDER_IDS = new Set([
  "constructor",
  "prototype",
  "tostring",
  "valueof",
  "hasownproperty",
]);

function requireOverlayText(
  source: string,
  value: unknown,
  where: string,
): string {
  if (typeof value !== "string" || !value.trim()) {
    failOverlay(source, `${where} must be a non-empty string.`);
  }
  return value;
}

/**
 * One overlay row, checked. A bad row stops the process at startup naming the row, exactly as a
 * bad base row does — a provider registered with a typo'd endpoint or a missing key variable is
 * a deployment mistake its author should meet before the first model call, not during it.
 */
export function customProviderFromRow(
  source: string,
  id: string,
  row: CustomProviderRow | undefined,
): ProviderSpec {
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(id) || RESERVED_PROVIDER_IDS.has(id)) {
    failOverlay(
      source,
      `providers.${id} is not a usable provider id (lowercase letters, digits and hyphens).`,
    );
  }
  if ((PROVIDER_IDS as readonly string[]).includes(id)) {
    failOverlay(
      source,
      `providers.${id} redefines a built-in provider; pick a different id.`,
    );
  }
  if (!row || typeof row !== "object") {
    failOverlay(source, `providers.${id} must be an object.`);
  }
  const baseUrl = requireOverlayText(source, row.base_url, `providers.${id}.base_url`);
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    failOverlay(source, `providers.${id}.base_url is not a URL: ${baseUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    failOverlay(source, `providers.${id}.base_url must be an http(s) URL.`);
  }
  const keyVariable = requireOverlayText(
    source,
    row.key_variable,
    `providers.${id}.key_variable`,
  );
  if (!ENV_VARIABLE_PATTERN.test(keyVariable)) {
    failOverlay(
      source,
      `providers.${id}.key_variable is not an environment variable name: ${keyVariable}`,
    );
  }
  // The endpoint override variable is derived from the id unless the row names one, so a custom
  // provider answers to the same "variable names the endpoint" shape the built-in rows use. An id
  // that leads with a digit (`9router`) derives a name no shell would accept, so it is prefixed.
  const derived = `${id.toUpperCase().replace(/-/g, "_")}_BASE_URL`;
  const baseUrlVariable =
    row.base_url_variable === undefined
      ? /^[0-9]/.test(derived)
        ? `PROVIDER_${derived}`
        : derived
      : requireOverlayText(
          source,
          row.base_url_variable,
          `providers.${id}.base_url_variable`,
        );
  if (!ENV_VARIABLE_PATTERN.test(baseUrlVariable)) {
    failOverlay(
      source,
      `providers.${id}.base_url_variable is not an environment variable name: ${baseUrlVariable}`,
    );
  }
  const api = row.api === undefined ? "chat" : row.api;
  if (api !== "chat") {
    failOverlay(
      source,
      `providers.${id}.api must be "chat" (OpenAI-compatible chat completions); other styles are not supported for custom providers.`,
    );
  }
  return {
    id: id as ModelProviderId,
    label: requireOverlayText(source, row.label, `providers.${id}.label`),
    keyVariable,
    baseUrlVariable,
    defaultModel: requireOverlayText(
      source,
      row.default_model,
      `providers.${id}.default_model`,
    ),
    baseUrl,
    api,
  };
}

/**
 * Parse one overlay source (the `CUSTOM_PROVIDERS_JSON` value, or a providers file's text).
 *
 * Exported so the parsing is testable without reloading this module: module load reads the real
 * environment once, which is the behaviour a deployment wants and the behaviour a test cannot
 * re-run in-process.
 */
export function parseCustomProvidersOverlay(
  text: string,
  source: string,
): CustomProvidersOverlay {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    failOverlay(source, "is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    failOverlay(source, "must hold a JSON object.");
  }
  const overlay = parsed as OverlayFile & Record<string, unknown>;
  /*
   * Two shapes are accepted. The wrapped one — {"providers": {…}, "bots": {…}} — is what the
   * overlay file and the examples use. The flat one — {"<provider id>": {…row…}} — is what a
   * hosting dashboard's environment variable naturally holds when a deployment registers a
   * single provider inline, and it is the shape the deploy instructions once handed out. A
   * flat overlay is recognised by the ABSENCE of the "providers" key; every other top-level
   * key but "bots" and "_readme" is then a provider id, and each row goes through the same
   * validation as a wrapped row, so a malformed flat overlay fails loudly at startup. It once
   * did not: a flat CUSTOM_PROVIDERS_JSON parsed to zero providers in silence, the registry
   * never learned the provider existed, BOT_PROVIDER named nothing, and the built-in Bots
   * failed at run time with a credential error naming a variable nobody had been told to set.
   */
  const providerRows: Record<string, unknown> =
    overlay.providers !== undefined
      ? (overlay.providers as Record<string, unknown>)
      : Object.fromEntries(
          Object.entries(overlay).filter(
            ([key]) => key !== "bots" && key !== "_readme",
          ),
        );
  const providers: ProviderSpec[] = [];
  for (const [id, row] of Object.entries(providerRows)) {
    providers.push(customProviderFromRow(source, id, row as CustomProviderRow));
  }
  const bots: Record<string, { provider: string; model: string }> = {};
  for (const [botId, entry] of Object.entries(overlay.bots ?? {})) {
    if (!entry || typeof entry !== "object") {
      failOverlay(source, `bots.${botId} must be an object.`);
    }
    bots[botId] = {
      provider: requireOverlayText(source, entry.provider, `bots.${botId}.provider`),
      model: requireOverlayText(source, entry.model, `bots.${botId}.model`),
    };
  }
  return { providers, bots };
}

/** Where the overlay file lives: the path the environment names, else beside the base spec. */
export function customProvidersFilePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const named = env.CUSTOM_PROVIDERS_PATH?.trim();
  if (named) return named;
  try {
    const dir = import.meta.dir;
    if (dir) return `${dir}/providers.local.json`;
  } catch {
    // Not a runtime that knows where this module lives; the env path is the only file source.
  }
  return "providers.local.json";
}

/**
 * The key variable a chat-added provider gets when its key is supplied directly and no variable
 * was named. The variable is only the registry row's fallback name: the actual key is stored in
 * the credential vault, and an environment value under this name still wins if one is later set.
 */
export function defaultKeyVariableForCustomProvider(id: string): string {
  const derived = `${id.toUpperCase().replace(/-/g, "_")}_API_KEY`;
  return /^[0-9]/.test(derived) ? `PROVIDER_${derived}` : derived;
}

/**
 * Merge overlay sources in ascending precedence: each later source wins per provider id and per
 * Bot entry. The server's database overlay is merged between the file and the environment, so
 * the standing order is file < database < `CUSTOM_PROVIDERS_JSON`.
 */
export function mergeCustomProvidersOverlays(
  ...overlays: readonly CustomProvidersOverlay[]
): CustomProvidersOverlay {
  const order: string[] = [];
  const byId = new Map<string, ProviderSpec>();
  let bots: Record<string, { provider: string; model: string }> = {};
  for (const overlay of overlays) {
    for (const spec of overlay.providers) {
      if (!byId.has(spec.id)) order.push(spec.id);
      byId.set(spec.id, spec);
    }
    bots = { ...bots, ...overlay.bots };
  }
  return {
    providers: order.map((id) => byId.get(id)).filter((spec) => spec !== undefined),
    bots,
  };
}

/** The overlay in the file source alone. A missing file is an empty overlay. */
export function readCustomProvidersFileOverlay(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CustomProvidersOverlay {
  let fileText: string | undefined;
  try {
    // Required lazily: this module is imported in places where node:fs may not exist at all
    // (bundled front-ends read the base spec through Vite), and an overlay file is a server-side
    // deployment fact. Bun and Node both resolve this fine where it matters.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    fileText = readFileSync(customProvidersFilePath(env), "utf-8");
  } catch {
    fileText = undefined;
  }
  return fileText === undefined
    ? { providers: [], bots: {} }
    : parseCustomProvidersOverlay(fileText, customProvidersFilePath(env));
}

/** The overlay in `CUSTOM_PROVIDERS_JSON` alone. An unset variable is an empty overlay. */
export function readCustomProvidersEnvOverlay(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CustomProvidersOverlay {
  const inline = env.CUSTOM_PROVIDERS_JSON?.trim();
  return inline
    ? parseCustomProvidersOverlay(inline, "CUSTOM_PROVIDERS_JSON")
    : { providers: [], bots: {} };
}

/**
 * The overlay this process runs with: file first, `CUSTOM_PROVIDERS_JSON` over it, so an
 * environment can restate one provider without restating them all. Absent both, an empty overlay
 * — the registry stays the three built-in rows and nothing about the base file's checks changes.
 *
 * A file that exists but does not parse stops startup like a bad base row; a file that does not
 * exist is simply no overlay, because the file is how a deployment opts in.
 */
function readOverlay(
  env: Readonly<Record<string, string | undefined>>,
): CustomProvidersOverlay {
  return mergeCustomProvidersOverlays(
    readCustomProvidersFileOverlay(env),
    readCustomProvidersEnvOverlay(env),
  );
}

/** One provider spec as the snake-case row every loader and the materialized file use. */
export function customProviderRowFromSpec(spec: ProviderSpec): {
  label: string;
  base_url: string;
  key_variable: string;
  base_url_variable: string;
  default_model: string;
  api: string;
} {
  if (!spec.baseUrl) {
    throw new Error(`Provider ${spec.id} has no endpoint to write as an overlay row.`);
  }
  return {
    label: spec.label,
    base_url: spec.baseUrl,
    key_variable: spec.keyVariable,
    base_url_variable: spec.baseUrlVariable,
    default_model: spec.defaultModel,
    api: spec.api ?? "chat",
  };
}

/**
 * Serialize an overlay for the file both loaders already read. It contains provider rows and
 * Bot selections only — never a key value; a row names the variable or vault entry for its key.
 */
export function serializeCustomProvidersOverlay(
  overlay: CustomProvidersOverlay,
): string {
  const providers: Record<string, ReturnType<typeof customProviderRowFromSpec>> = {};
  for (const spec of overlay.providers) {
    providers[spec.id] = customProviderRowFromSpec(spec);
  }
  return `${JSON.stringify({ providers, bots: overlay.bots }, null, 2)}\n`;
}

/**
 * Materialize an already-merged overlay to the overlay file path. The server calls this after
 * reading its durable database rows, so separate processes (notably the Python loader) see the
 * same registry without needing a database connection of their own.
 */
export function writeCustomProvidersOverlayFile(
  overlay: CustomProvidersOverlay,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  const path = customProvidersFilePath(env);
  writeFileSync(path, serializeCustomProvidersOverlay(overlay), "utf-8");
  return path;
}

/**
 * Add or replace one provider in the overlay file, through the same validation a load applies.
 *
 * This is the write half of the overlay store — the platform-tools `add_custom_provider` tool
 * calls it — so a provider a Bot registers is a provider the next load validates identically.
 * Returns the path written. Other overlay sources (the env JSON) are untouched and still win for
 * any id they also name, because env-over-file is this registry's standing order.
 */
export function upsertCustomProviderFile(
  spec: Omit<ProviderSpec, "baseUrlVariable"> & { baseUrlVariable?: string },
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const { readFileSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const path = customProvidersFilePath(env);
  let current: OverlayFile = {};
  try {
    const text = readFileSync(path, "utf-8");
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed as OverlayFile;
    }
  } catch {
    current = {};
  }
  // Validate the row as a load would, before it is written where a load will find it.
  const row: CustomProviderRow = {
    label: spec.label,
    base_url: spec.baseUrl,
    key_variable: spec.keyVariable,
    base_url_variable: spec.baseUrlVariable,
    default_model: spec.defaultModel,
    api: spec.api ?? "chat",
  };
  customProviderFromRow(path, spec.id, row);
  const providers = { ...(current.providers ?? {}), [spec.id]: row };
  writeFileSync(path, `${JSON.stringify({ ...current, providers }, null, 2)}\n`, "utf-8");
  return path;
}

function fail(problem: string): never {
  throw new Error(`shared/model-providers.json: ${problem}`);
}

function requireText(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${where} must be a non-empty string.`);
  }
  return value;
}

/**
 * The file, checked. Every read below is of a row this function has already seen.
 *
 * Checked once, at module load, because the failure it reports is a mistake in the repository
 * rather than in a deployment: a hand editing the JSON wrong should stop every Bot at startup
 * with the key they got wrong, not send one Bot to a model named by a typo.
 */
function readSpec(): {
  providers: Record<string, ProviderSpec>;
  bots: Record<string, { provider: string; model: string }>;
  customProviderIds: readonly string[];
} {
  const spec = specJson as SpecFile;

  const providers: Record<string, ProviderSpec> = {};
  for (const id of PROVIDER_IDS) {
    const row = spec.providers?.[id];
    if (!row) fail(`providers is missing its ${id} row.`);
    providers[id] = {
      id,
      label: requireText(row.label, `providers.${id}.label`),
      keyVariable: requireText(
        row.key_variable,
        `providers.${id}.key_variable`,
      ),
      baseUrlVariable: requireText(
        row.base_url_variable,
        `providers.${id}.base_url_variable`,
      ),
      defaultModel: requireText(
        row.default_model,
        `providers.${id}.default_model`,
      ),
    };
  }
  for (const id of Object.keys(spec.providers ?? {})) {
    if (!(PROVIDER_IDS as readonly string[]).includes(id)) {
      fail(`providers has a ${id} row this module has never heard of.`);
    }
  }

  /*
   * The custom-provider overlay, read after the base rows so its ids join the set a `bots` entry
   * may name. The base file's own rows were checked against PROVIDER_IDS alone above, on purpose:
   * a custom provider belongs to the overlay sources, never smuggled into the contract file.
   */
  const overlay = readOverlay(process.env);
  for (const custom of overlay.providers) {
    providers[custom.id] = custom;
  }
  const allProviderIds = Object.keys(providers);

  const bots: Record<string, { provider: string; model: string }> = {};
  const absorbBots = (
    entries: Readonly<Record<string, SpecBotRow | undefined>>,
    source: string,
  ) => {
    for (const [botId, entry] of Object.entries(entries)) {
      if (!entry) fail(`${source}bots.${botId} must be an object.`);
      const provider = requireText(entry.provider, `${source}bots.${botId}.provider`);
      if (!allProviderIds.includes(provider)) {
        fail(
          `${source}bots.${botId}.provider is ${JSON.stringify(provider)}, not one of ${allProviderIds.join(", ")}.`,
        );
      }
      bots[botId] = {
        provider,
        model: requireText(entry.model, `${source}bots.${botId}.model`),
      };
    }
  };
  absorbBots(spec.bots ?? {}, "");
  absorbBots(overlay.bots, "overlay ");

  return {
    providers,
    bots,
    customProviderIds: overlay.providers.map((custom) => custom.id),
  };
}

const {
  providers: SPEC_PROVIDERS,
  bots: BOT_ENTRIES,
  customProviderIds: CUSTOM_IDS,
} = readSpec();

export const MODEL_PROVIDERS: Record<string, ProviderSpec> = SPEC_PROVIDERS;

/** The custom provider ids this process loaded from the overlay (empty when none is configured). */
export const CUSTOM_PROVIDER_IDS: readonly string[] = CUSTOM_IDS;

/** Every provider id the registry answers for: the built-ins, then the custom overlay's. */
export const ALL_PROVIDER_IDS: readonly string[] = [
  ...PROVIDER_IDS,
  ...CUSTOM_IDS,
];

/**
 * The provider somebody configured, or nothing if they named one nobody has heard of.
 *
 * Blank means OpenAI, because that is what every other reader of `BOT_PROVIDER` already decided:
 * the desktop writes an empty provider when switching back to OpenAI, the server reads empty as
 * OpenAI, and a compose file passing `${BOT_PROVIDER:-}` hands the variable an empty string rather
 * than no variable at all. A Bot that refused that would disagree with the screen that configured
 * it.
 *
 * Padded and differently-cased names are the same provider, for the same reason `BOT_MODEL` is
 * trimmed before it is used: a value somebody typed into a setup window arrives with a space on
 * it more often than not. A Bot that has to report which provider was named gets `undefined` here
 * and shows the raw value in its own message.
 */
export function providerSpec(
  provider: string | undefined,
): ProviderSpec | undefined {
  const normalized = provider?.trim().toLowerCase() || "openai";
  return Object.hasOwn(MODEL_PROVIDERS, normalized)
    ? MODEL_PROVIDERS[normalized]
    : undefined;
}

/** The environment variable this provider's key arrives in, or nothing for a provider unknown. */
export function keyVariableFor(
  provider: string | undefined,
): string | undefined {
  return providerSpec(provider)?.keyVariable;
}

/** The environment variable an endpoint override for this provider arrives in. */
export function baseUrlVariableFor(
  provider: string | undefined,
): string | undefined {
  return providerSpec(provider)?.baseUrlVariable;
}

/**
 * What this Bot runs when it was told a provider and no usable model.
 *
 * An unknown provider falls back to the OpenAI default rather than refusing here, because the
 * Bots validate the provider themselves and their error message is the one that should name what
 * went wrong. This function is asked before that check runs.
 */
export function defaultModelFor(provider: string | undefined): string {
  return (
    providerSpec(provider)?.defaultModel ?? MODEL_PROVIDERS.openai.defaultModel
  );
}

/**
 * The model this Bot runs: what was configured, or the provider's default when it was not.
 *
 * Blank is not configured. A compose file passing `BOT_MODEL: ${BOT_MODEL:-}` hands this an empty
 * string, and a Bot that sent it on would ask its provider for a model named "" and die with
 * "you must provide a model parameter", which reads as a broken Bot rather than as missing
 * configuration.
 */
export function configuredModel(
  provider: string | undefined,
  configured: string | undefined,
): string {
  return configured?.trim() || defaultModelFor(provider);
}

/** What one Bot was decided to run: its provider, and the model on it. */
export type BotSettings = {
  /** The provider this Bot answers on. */
  readonly provider: string;
  /** The model it runs. */
  readonly model: string;
};

/**
 * This Bot's provider and model: environment over spec file over provider default.
 *
 * The lookup order is the whole contract, and it is the order `docs/configuration.md` already
 * documents for `BOT_PROVIDER` and `BOT_MODEL` — the environment is how a deployment overrides
 * what the repository decided, so it wins. What is new is the middle: `model-providers.json`'s
 * `bots` entry, the default this Bot had before this function existed, written down in one file
 * every language in the box reads instead of repeated in each Bot's source. What is unchanged is
 * the last: the provider's own default row, for a provider whose Bot entry the file pairs with
 * somebody else.
 *
 * `pinnedProvider` is for a Bot that drives exactly one provider's API and answers to no other
 * name — `agent-bot` speaks chat completions by hand and has never read `BOT_PROVIDER`. Pinning
 * keeps that Bot's behavior what it was while its model still comes from the file.
 *
 * A provider nobody has heard of is kept as typed, not rewritten to OpenAI, so the Bot's own
 * refusal can put the name in its message. Its model falls back to the OpenAI default for the
 * same reason `defaultModelFor` does it: the refusal is one line below and belongs to the Bot.
 *
 * A missing `bots` entry throws rather than defaults. The file is in this repository; a Bot wired
 * to it without a row is a mistake made while editing it, made at development time, and the
 * developer should meet it at startup rather than wonder why every deployment answers on
 * gpt-5.5.
 */
export function botSettings(
  botId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  pinnedProvider?: string,
): BotSettings {
  const entry = Object.hasOwn(BOT_ENTRIES, botId)
    ? BOT_ENTRIES[botId]
    : undefined;
  if (!entry) {
    fail(
      `bots has no ${botId} entry. Add one before this Bot reads the spec file.`,
    );
  }

  const provider =
    pinnedProvider?.trim() ||
    (env.BOT_PROVIDER ?? "").trim().toLowerCase() ||
    entry.provider;

  // A model the environment names goes to whatever provider was resolved, because an endpoint
  // names its own catalogue. The file's model belongs to the file's provider, so a deployment
  // that moved this Bot to another provider gets that provider's default instead of a model
  // paired with the one it left.
  const model =
    env.BOT_MODEL?.trim() ||
    (provider === entry.provider ? entry.model : defaultModelFor(provider));

  return { provider, model };
}

/**
 * Whether this model has to be driven through the Responses API.
 *
 * `gpt-5.6-*` rejects function tools on `/v1/chat/completions` — "To use function tools, use
 * /v1/responses or set reasoning_effort to 'none'" — so a Bot that speaks chat completions by hand
 * cannot use it, and a Bot whose integration offers the Responses API has to turn it on. The same
 * predicate answers both questions; which question is asked belongs to the Bot.
 *
 * Named for the fact rather than for either consequence, because `agent-bot` uses it to refuse a
 * model and `agent-langgraph` uses it to select a flag, and neither name fits both.
 */
export function requiresResponsesApi(model: string): boolean {
  return /^gpt-5\.[6-9]|^gpt-[6-9]/.test(model);
}

/**
 * Whether this Bot must hold this provider's key before it can start.
 *
 * Not when an endpoint was named to answer instead. `OPENAI_BASE_URL` set means any endpoint
 * speaking that API, and Ollama, vLLM, LM Studio and llama.cpp all serve it with no key. The
 * setup window offers exactly those by name and accepts a blank key for them, so requiring one
 * refused the whole keyless half of that feature: somebody filled in an address, the app raised
 * the Bot, and it exited on startup complaining about a key their endpoint does not have.
 *
 * Only OpenAI has a base URL that means "somebody else's server"; Anthropic and Google are asked
 * with their own variable so the rule can grow without a second signature.
 */
export function keyIsRequired(
  provider: string | undefined,
  baseUrl: string | undefined,
): boolean {
  const spec = providerSpec(provider);
  // A custom provider is an endpoint somebody named, like the OpenAI case below: whether it
  // demands a key is the endpoint's own policy, and a caller that needs a string to construct
  // its client gets the placeholder from `apiKeyOrPlaceholder`.
  if (spec?.baseUrl) return false;
  const named = spec?.id === "openai" && Boolean(baseUrl?.trim());
  return !named;
}

/**
 * What to hand an SDK that insists on a string even when the endpoint ignores it.
 *
 * A placeholder rather than an empty string: empty is a client that cannot be constructed, and
 * the value is never sent anywhere that reads it when the endpoint needs no key.
 */
export function apiKeyOrPlaceholder(apiKey: string | undefined): string {
  return apiKey?.trim() || "no-key-needed";
}
