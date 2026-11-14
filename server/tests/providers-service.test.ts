import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import {
  mergeCustomProvidersOverlays,
  readCustomProvidersEnvOverlay,
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
