import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mergeCustomProvidersOverlays,
  readCustomProvidersEnvOverlay,
  readCustomProvidersFileOverlay,
} from "../../shared/model-providers";
import type { AppVariables } from "../src/auth/guards";
import { builtInAgentConfiguration, runtimeModelForEnvironment } from "../src/copilot";
import {
  CUSTOM_PROVIDER_CREDENTIAL_PROVIDER,
  customProviderCredentialKeyId,
  decryptSecret,
  encryptSecret,
  resolveModelApiKey,
  type CredentialInput,
} from "../src/credentials";
import {
  CustomProviderRegistry,
  customProvidersOverlayFromRecords,
  InMemoryCustomProviderStore,
} from "../src/providers/custom-providers";
import {
  environmentWithDeploymentDefault,
  InMemoryDeploymentDefaultStore,
} from "../src/providers/deployment-default";
import { createProviderRoutes } from "../src/providers/routes";
import { createProvidersService, type ProvidersService } from "../src/providers/service";

/**
 * The Providers service and its HTTP routes, on in-memory stores.
 *
 * One implementation sits behind the Providers page and the Platform Tools, so what is
 * pinned here is the shared behaviour: a chat-style add (the service call the tool makes)
 * with a key and use_as_default lands a provider a built-in Bot then resolves through —
 * provider, model and key — with no package credential anywhere; and the routes gate on
 * admin, report sources honestly, and never let a key value out.
 */

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/** An encrypted-secret vault in a Map, keyed by the reader's own coordinates. */
function memoryVault() {
  const secrets = new Map<string, string>();
  const coordinates = (provider: string, keyId: string) => `${provider}:${keyId}`;
  return {
    reader: {
      readModelSecret: async ({
        provider,
        keyId,
      }: {
        provider: string;
        keyId: string;
      }) => {
        const encryptedValue = secrets.get(coordinates(provider, keyId));
        return encryptedValue ? { encryptedValue } : null;
      },
    },
    credentialAdmin: {
      create: async (input: CredentialInput) => {
        secrets.set(
          coordinates(input.provider, input.keyId),
          await encryptSecret(KEY, input.plaintext),
        );
        return { id: "credential-1" };
      },
    },
  };
}

const ENV_WITH_ROUTER = {
  CUSTOM_PROVIDERS_JSON: JSON.stringify({
    providers: {
      envrouter: {
        label: "Env Router",
        base_url: "https://env.example/v1",
        key_variable: "ENVROUTER_API_KEY",
        default_model: "env-1",
        api: "chat",
      },
    },
  }),
};

function buildService(env: Record<string, string | undefined> = {}) {
  // Registration materializes the merged overlay to a file; keep that file in /tmp, never
  // beside the real spec, where a fresh process's loader would pick the rows up.
  env = { CUSTOM_PROVIDERS_PATH: "/tmp/openbot-providers-test.local.json", ...env };
  const store = new InMemoryCustomProviderStore();
  const registry = new CustomProviderRegistry(
    mergeCustomProvidersOverlays(readCustomProvidersEnvOverlay(env)),
  );
  const vault = memoryVault();
  const deploymentDefaultStore = new InMemoryDeploymentDefaultStore();
  const service = createProvidersService({
    store,
    registry,
    credentialAdmin: vault.credentialAdmin,
    credentialReader: vault.reader,
    deploymentDefaultStore,
    env,
  });
  return { service, store, registry, vault, deploymentDefaultStore };
}

describe("the PicoClaw act: add a provider with its key and use it", () => {
  test("the Bot resolves provider, model and key with no package credential anywhere", async () => {
    const { service, registry, vault, deploymentDefaultStore } = buildService();
    // The environment even pins a different provider; the in-app default must outrank it.
    const environment: Record<string, string | undefined> = {
      BOT_PROVIDER: "9router",
      BOT_MODEL: "hermes",
    };

    const outcome = await service.add({
      actorId: "admin-1",
      actorLabel: "admin@example.test",
      id: "acme",
      label: "Acme",
      baseUrl: "https://acme.example/v1",
      defaultModel: "acme-1",
      apiKey: "acme-secret",
      useAsDefault: true,
      model: "acme-2",
    });
    expect(outcome.credentialStored).toBe(true);
    expect(outcome.defaultSet).toEqual({ provider: "acme", model: "acme-2" });
    expect(await deploymentDefaultStore.get()).toEqual({
      provider: "acme",
      model: "acme-2",
    });
    expect(registry.exists("acme")).toBe(true);

    const effective = environmentWithDeploymentDefault(
      environment,
      await deploymentDefaultStore.get(),
    );
    const model = runtimeModelForEnvironment(
      { provider: "openai", defaultModel: "gpt-5.6-terra" },
      effective,
      (provider) => registry.lookup(provider),
    );
    expect(model.customProvider?.id).toBe("acme");
    expect(model.customProvider?.baseUrl).toBe("https://acme.example/v1");
    expect(model.defaultModel).toBe("acme-2");

    const apiKey = await resolveModelApiKey({
      encryptionKey: KEY,
      reader: vault.reader,
      provider: model.provider,
      keyVariable: model.customProvider?.keyVariable,
      customProviderId: model.customProvider?.id,
      keyId: "package-credential-that-was-never-added",
      environment: effective,
    });
    expect(apiKey).toBe("acme-secret");

    const configuration = builtInAgentConfiguration(
      {
        id: "general-assistant",
        name: "General Assistant",
        type: "built_in",
        systemPrompt: "Be helpful.",
      },
      model,
      apiKey,
    );
    // Not the throwing factory: a real configuration, on the new provider and model.
    expect((configuration as Record<string, unknown>).type).toBeUndefined();
    expect(configuration.model).toBe("openai/acme-2");
    expect(configuration.apiKey).toBe("acme-secret");
  });

  test("the list reports the app-added row's source and key presence, never the key", async () => {
    const { service } = buildService(ENV_WITH_ROUTER);
    await service.add({
      actorId: "admin-1",
      actorLabel: "admin@example.test",
      id: "acme",
      label: "Acme",
      baseUrl: "https://acme.example/v1",
      defaultModel: "acme-1",
      apiKey: "acme-secret",
      useAsDefault: true,
    });
    const rows = await service.list();
    const acme = rows.find((row) => row.id === "acme");
    expect(acme).toMatchObject({
      source: "db",
      keyPresent: true,
      isDefault: true,
      defaultModel: "acme-1",
    });
    const envRouter = rows.find((row) => row.id === "envrouter");
    expect(envRouter).toMatchObject({ source: "env", keyPresent: false });
    const openai = rows.find((row) => row.id === "openai");
    expect(openai?.source).toBe("builtin");
    expect(JSON.stringify(rows)).not.toContain("acme-secret");
  });

  test("setDefault refuses an unknown provider and changes nothing", async () => {
    const { service, deploymentDefaultStore } = buildService();
    await expect(
      service.setDefault({ provider: "no-such-provider", actorLabel: "admin" }),
    ).rejects.toThrow('no provider registered as "no-such-provider"');
    expect(await deploymentDefaultStore.get()).toBeNull();
  });
});

function buildApp(service: ProvidersService) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", async (context, next) => {
    const role = context.req.header("x-role") === "user" ? "user" : "admin";
    context.set("actor", {
      id: "admin-1",
      email: "admin@example.test",
      role: role as "admin" | "user",
    });
    await next();
  });
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
    _context,
    next,
  ) => {
    await next();
  };
  app.route("/api/providers", createProviderRoutes(service, requireUser));
  return app;
}

const json = (body: unknown) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("the Providers routes", () => {
  test("a non-admin is refused at the gate", async () => {
    const { service } = buildService();
    const app = buildApp(service);
    const response = await app.request("/api/providers", {
      headers: { "x-role": "user" },
    });
    expect(response.status).toBe(403);
  });

  test("create → list shows source db and a present key, with no key value anywhere", async () => {
    const { service, vault } = buildService(ENV_WITH_ROUTER);
    const app = buildApp(service);

    const created = await app.request("/api/providers", {
      method: "POST",
      ...json({
        id: "acme",
        label: "Acme",
        base_url: "https://acme.example/v1",
        default_model: "acme-1",
        api_key: "first-key",
      }),
    });
    expect(created.status).toBe(201);
    expect(await created.text()).not.toContain("first-key");

    const listed = await app.request("/api/providers");
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      providers: { id: string; source: string; keyPresent: boolean }[];
      deploymentDefault: unknown;
    };
    expect(JSON.stringify(body)).not.toContain("first-key");
    expect(body.providers.find((row) => row.id === "acme")).toMatchObject({
      source: "db",
      keyPresent: true,
    });
    expect(body.providers.find((row) => row.id === "envrouter")?.source).toBe("env");

    // Posting the provider again with a new key replaces it (keys are write-only).
    const replaced = await app.request("/api/providers", {
      method: "POST",
      ...json({
        id: "acme",
        label: "Acme",
        base_url: "https://acme.example/v1",
        default_model: "acme-1",
        api_key: "second-key",
      }),
    });
    expect(replaced.status).toBe(201);
    const stored = await vault.reader.readModelSecret({
      provider: CUSTOM_PROVIDER_CREDENTIAL_PROVIDER,
      keyId: customProviderCredentialKeyId("acme"),
    });
    expect(stored).not.toBeNull();
    expect(await decryptSecret(KEY, stored!.encryptedValue)).toBe("second-key");
  });

  test("default set and clear: set marks the row, deleting the default clears it", async () => {
    const { service } = buildService(ENV_WITH_ROUTER);
    const app = buildApp(service);
    await app.request("/api/providers", {
      method: "POST",
      ...json({
        id: "acme",
        label: "Acme",
        base_url: "https://acme.example/v1",
        default_model: "acme-1",
        api_key: "acme-key",
      }),
    });

    const refused = await app.request("/api/providers/default", {
      method: "POST",
      ...json({ provider: "no-such-provider" }),
    });
    expect(refused.status).toBe(400);

    const set = await app.request("/api/providers/default", {
      method: "POST",
      ...json({ provider: "acme", model: "acme-9" }),
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({
      deploymentDefault: { provider: "acme", model: "acme-9" },
    });

    const listed = await app.request("/api/providers");
    const body = (await listed.json()) as {
      providers: { id: string; isDefault: boolean }[];
      deploymentDefault: unknown;
    };
    expect(body.providers.find((row) => row.id === "acme")?.isDefault).toBe(true);
    expect(body.deploymentDefault).toEqual({ provider: "acme", model: "acme-9" });

    const removed = await app.request("/api/providers/acme", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true, clearedDefault: true });

    const after = await app.request("/api/providers");
    const afterBody = (await after.json()) as {
      providers: { id: string }[];
      deploymentDefault: unknown;
    };
    expect(afterBody.providers.some((row) => row.id === "acme")).toBe(false);
    expect(afterBody.deploymentDefault).toBeNull();
  });

  test("delete refuses built-in and environment rows with a clear message", async () => {
    const { service } = buildService(ENV_WITH_ROUTER);
    const app = buildApp(service);

    const builtin = await app.request("/api/providers/openai", { method: "DELETE" });
    expect(builtin.status).toBe(400);
    expect(((await builtin.json()) as { error: string }).error).toContain(
      "built-in provider; it cannot be deleted",
    );

    const envRow = await app.request("/api/providers/envrouter", { method: "DELETE" });
    expect(envRow.status).toBe(400);
    expect(((await envRow.json()) as { error: string }).error).toContain(
      "cannot be deleted here",
    );
  });
});

describe("one row per provider, badged by the source whose row wins", () => {
  test("a file-only provider is badged file and listed once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-providers-file-"));
    const overlayPath = join(dir, "providers.local.json");
    writeFileSync(
      overlayPath,
      JSON.stringify({
        providers: {
          filerouter: {
            label: "File Router",
            base_url: "https://file.example/v1",
            key_variable: "FILEROUTER_API_KEY",
            default_model: "file-1",
            api: "chat",
          },
        },
      }),
    );
    const env = { CUSTOM_PROVIDERS_PATH: overlayPath };
    const store = new InMemoryCustomProviderStore();
    const registry = new CustomProviderRegistry(
      mergeCustomProvidersOverlays(
        readCustomProvidersFileOverlay(env),
        readCustomProvidersEnvOverlay(env),
      ),
    );
    const vault = memoryVault();
    const service = createProvidersService({
      store,
      registry,
      credentialAdmin: vault.credentialAdmin,
      credentialReader: vault.reader,
      deploymentDefaultStore: new InMemoryDeploymentDefaultStore(),
      env,
    });
    const rows = await service.list();
    const fileRows = rows.filter((row) => row.id === "filerouter");
    expect(fileRows).toHaveLength(1);
    expect(fileRows[0]).toMatchObject({ source: "file", keyPresent: false });
    await rm(dir, { recursive: true, force: true });
  });

  test("a provider in the database and the materialized file lists once, badged db", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openbot-providers-restart-"));
    const overlayPath = join(dir, "providers.local.json");
    const env = { CUSTOM_PROVIDERS_PATH: overlayPath };
    const first = buildService(env);
    await first.service.add({
      actorId: "admin-1",
      actorLabel: "admin@example.test",
      id: "acme",
      label: "Acme",
      baseUrl: "https://acme.example/v1",
      defaultModel: "acme-1",
      apiKey: "acme-secret",
    });
    // The add materialized the merged overlay: the file now names acme too.
    expect(readCustomProvidersFileOverlay(env).providers.map((spec) => spec.id)).toContain(
      "acme",
    );
    // A restart rebuilds the registry the way index.ts does — file < database < env,
    // over the same durable store — and the list must still show acme exactly once,
    // badged by its origin (the database), not by the file that cached it.
    const registry = new CustomProviderRegistry(
      mergeCustomProvidersOverlays(
        readCustomProvidersFileOverlay(env),
        customProvidersOverlayFromRecords(await first.store.list()),
        readCustomProvidersEnvOverlay(env),
      ),
    );
    const restarted = createProvidersService({
      store: first.store,
      registry,
      credentialAdmin: first.vault.credentialAdmin,
      credentialReader: first.vault.reader,
      deploymentDefaultStore: first.deploymentDefaultStore,
      env,
    });
    const rows = await restarted.list();
    const acmeRows = rows.filter((row) => row.id === "acme");
    expect(acmeRows).toHaveLength(1);
    expect(acmeRows[0]).toMatchObject({ source: "db", keyPresent: true });
    await rm(dir, { recursive: true, force: true });
  });
});

describe("the effective default: what the deployment actually runs on", () => {
  test("an environment pin is the effective default, with BOT_MODEL as its model", async () => {
    const { service } = buildService({
      ...ENV_WITH_ROUTER,
      BOT_PROVIDER: "envrouter",
      BOT_MODEL: "env-9",
    });
    expect(await service.effectiveDefault()).toEqual({
      provider: "envrouter",
      model: "env-9",
      origin: "env",
    });
    const rows = await service.list();
    expect(rows.find((row) => row.id === "envrouter")).toMatchObject({
      isDefault: true,
      defaultOrigin: "env",
    });
    expect(rows.find((row) => row.id === "openai")).toMatchObject({
      isDefault: false,
      defaultOrigin: null,
    });
    // The stored in-app default stays empty: the pin is reported, not rewritten.
    expect(await service.deploymentDefault()).toBeNull();
  });

  test("an environment pin without BOT_MODEL uses the provider row's default model", async () => {
    const { service } = buildService({
      ...ENV_WITH_ROUTER,
      BOT_PROVIDER: "envrouter",
    });
    expect(await service.effectiveDefault()).toEqual({
      provider: "envrouter",
      model: "env-1",
      origin: "env",
    });
  });

  test("the in-app default outranks the environment pin", async () => {
    const { service } = buildService({
      ...ENV_WITH_ROUTER,
      BOT_PROVIDER: "openai",
      BOT_MODEL: "gpt-pinned",
    });
    await service.setDefault({ provider: "envrouter", actorLabel: "admin" });
    expect(await service.effectiveDefault()).toEqual({
      provider: "envrouter",
      model: "env-1",
      origin: "db",
    });
    const rows = await service.list();
    expect(rows.find((row) => row.id === "envrouter")).toMatchObject({
      isDefault: true,
      defaultOrigin: "db",
    });
    expect(rows.find((row) => row.id === "openai")?.isDefault).toBe(false);
  });

  test("no pin and no in-app default: no effective default, nothing marked", async () => {
    const { service } = buildService(ENV_WITH_ROUTER);
    expect(await service.effectiveDefault()).toBeNull();
    const rows = await service.list();
    expect(rows.every((row) => !row.isDefault && row.defaultOrigin === null)).toBe(
      true,
    );
  });

  test("the routes report the effective default alongside the stored one", async () => {
    const { service } = buildService({
      ...ENV_WITH_ROUTER,
      BOT_PROVIDER: "envrouter",
      BOT_MODEL: "env-9",
    });
    const app = buildApp(service);
    const listed = await app.request("/api/providers");
    const body = (await listed.json()) as {
      deploymentDefault: unknown;
      effectiveDefault: unknown;
    };
    expect(body.deploymentDefault).toBeNull();
    expect(body.effectiveDefault).toEqual({
      provider: "envrouter",
      model: "env-9",
      origin: "env",
    });
  });
});

/**
 * The live page's exact failure shape, in a fresh process: the suite's own process
 * carries no CUSTOM_PROVIDERS_JSON, so the shared module never folded an overlay row
 * into MODEL_PROVIDERS here and the duplication cannot occur in-process. The fixture
 * runs with a production deployment's environment — flat CUSTOM_PROVIDERS_JSON, the
 * materialized overlay file a previous boot left, BOT_PROVIDER/BOT_MODEL pinned —
 * and prints the list the page would render.
 */
describe("the production shape (fresh process)", () => {
  const serverRoot = fileURLToPath(new URL("..", import.meta.url));
  const ROUTER_ROW = {
    label: "9Router",
    base_url: "https://ninerouter-vzw3.onrender.com/v1",
    key_variable: "NINEROUTER_API_KEY",
    default_model: "auto",
    api: "chat",
  };

  async function runProductionShape(extraEnv: Record<string, string>) {
    const dir = await mkdtemp(join(tmpdir(), "openbot-providers-shape-"));
    const overlayPath = join(dir, "providers.local.json");
    await writeFile(
      overlayPath,
      JSON.stringify({ providers: { "9router": ROUTER_ROW }, bots: {} }),
    );
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        "tests/fixtures/providers-list-production-shape.ts",
      ],
      cwd: serverRoot,
      env: {
        PATH: process.env.PATH ?? "",
        CUSTOM_PROVIDERS_JSON: JSON.stringify({ "9router": ROUTER_ROW }),
        CUSTOM_PROVIDERS_PATH: overlayPath,
        NINEROUTER_API_KEY: "shape-secret",
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) {
        throw new Error(`fixture exited ${exitCode}: ${stderr}`);
      }
      expect(stdout).not.toContain("shape-secret");
      return JSON.parse(stdout.trim()) as {
        providers: {
          id: string;
          source: string;
          keyPresent: boolean;
          isDefault: boolean;
          defaultOrigin: string | null;
        }[];
        effectiveDefault: unknown;
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test(
    "env + materialized file: one 9router row, badged env, marked the default from env",
    async () => {
      const { providers, effectiveDefault } = await runProductionShape({
        BOT_PROVIDER: "9router",
        BOT_MODEL: "hermes",
      });
      expect(providers.map((row) => row.id)).toEqual([
        "openai",
        "anthropic",
        "google",
        "9router",
      ]);
      const router = providers.find((row) => row.id === "9router");
      expect(router).toMatchObject({
        source: "env",
        keyPresent: true,
        isDefault: true,
        defaultOrigin: "env",
      });
      for (const builtin of providers.slice(0, 3)) {
        expect(builtin).toMatchObject({ source: "builtin", isDefault: false });
      }
      expect(effectiveDefault).toEqual({
        provider: "9router",
        model: "hermes",
        origin: "env",
      });
    },
    30_000,
  );

  test(
    "the same deployment without the env pin: one row, no default marked",
    async () => {
      const { providers, effectiveDefault } = await runProductionShape({});
      expect(providers.filter((row) => row.id === "9router")).toHaveLength(1);
      expect(providers.find((row) => row.id === "9router")).toMatchObject({
        source: "env",
        isDefault: false,
        defaultOrigin: null,
      });
      expect(effectiveDefault).toBeNull();
    },
    30_000,
  );
});
