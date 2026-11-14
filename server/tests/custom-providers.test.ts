import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decryptSecret,
  encryptSecret,
  resolveModelApiKey,
  type CredentialInput,
} from "../src/credentials";
import {
  callTool,
  usePlatformTools,
  type PlatformTools,
} from "../src/plugins/builtin-platform";
import {
  CustomProviderRegistry,
  InMemoryCustomProviderStore,
  registerChatCustomProvider,
  syncCustomProvidersOverlay,
} from "../src/providers/custom-providers";

/**
 * Durable custom providers: the database overlay, its merge order, and the chat add that
 * fills it.
 *
 * Three claims carry the weight. The merge order is environment > database > file, and what
 * lands in the materialized overlay file is rows only — key-variable names, never a key value.
 * A key given in chat is encrypted into the vault under coordinates derived from the provider
 * id, and a search of every artifact the add produced (store dump, overlay file, vault dump,
 * tool result) finds no trace of its plaintext. And resolution reads the environment first,
 * then that vault entry — the same order FEATURES.md documents.
 */

const encryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const CONNECTION = {
  url: "builtin://platform-tools",
  actorId: "admin-1",
  botId: "bot-1",
};

afterEach(() => usePlatformTools(null));

function row(baseUrl: string, keyVariable: string) {
  return {
    label: "Router",
    base_url: baseUrl,
    key_variable: keyVariable,
    default_model: "auto:default",
    api: "chat",
  };
}

describe("the database overlay merge", () => {
  test("environment beats database beats file, and the merged overlay is materialized", async () => {
    const dir = mkdtempSync(join(tmpdir(), "custom-providers-"));
    const path = join(dir, "providers.local.json");
    writeFileSync(
      path,
      JSON.stringify({
        providers: {
          "shared-router": row("https://file.example/v1", "FILE_API_KEY"),
          "file-only": row("https://file-only.example/v1", "FILE_ONLY_API_KEY"),
        },
      }),
      "utf-8",
    );
    const store = new InMemoryCustomProviderStore([
      {
        id: "shared-router",
        label: "Router",
        baseUrl: "https://db.example/v1",
        keyVariable: "DB_API_KEY",
        defaultModel: "auto:default",
      },
      {
        id: "db-only",
        label: "Db Only",
        baseUrl: "https://db-only.example/v1",
        keyVariable: "DB_ONLY_API_KEY",
        defaultModel: "auto:default",
      },
    ]);
    const env = {
      CUSTOM_PROVIDERS_PATH: path,
      CUSTOM_PROVIDERS_JSON: JSON.stringify({
        providers: {
          "shared-router": row("https://env.example/v1", "ENV_API_KEY"),
        },
      }),
    };

    const sync = await syncCustomProvidersOverlay({ store, env });
    const registry = new CustomProviderRegistry(sync.overlay);
    expect(registry.lookup("shared-router")?.baseUrl).toBe(
      "https://env.example/v1",
    );
    expect(registry.lookup("shared-router")?.keyVariable).toBe("ENV_API_KEY");
    expect(registry.lookup("db-only")?.baseUrl).toBe(
      "https://db-only.example/v1",
    );
    expect(registry.lookup("file-only")?.baseUrl).toBe(
      "https://file-only.example/v1",
    );
    expect(registry.exists("openai")).toBe(true);
    expect(sync.materializedPath).toBe(path);

    // The materialized file is what the other loaders read: every source's winner, as rows.
    const materialized = readFileSync(path, "utf-8");
    const parsed = JSON.parse(materialized) as {
      providers: Record<string, { base_url: string; key_variable: string }>;
    };
    expect(parsed.providers["shared-router"].base_url).toBe(
      "https://env.example/v1",
    );
    expect(parsed.providers["db-only"].base_url).toBe(
      "https://db-only.example/v1",
    );
    expect(parsed.providers["file-only"].base_url).toBe(
      "https://file-only.example/v1",
    );
    // Rows carry key-variable NAMES only — there is no key value anywhere in the file.
    expect(materialized).toContain("ENV_API_KEY");
    expect(materialized).not.toContain("api_key");
  });

  test("an unwritable overlay path warns and the registry still merges", async () => {
    const store = new InMemoryCustomProviderStore([
      {
        id: "db-only",
        label: "Db Only",
        baseUrl: "https://db-only.example/v1",
        keyVariable: "DB_ONLY_API_KEY",
        defaultModel: "auto:default",
      },
    ]);
    const sync = await syncCustomProvidersOverlay({
      store,
      env: { CUSTOM_PROVIDERS_PATH: "/nonexistent-dir/providers.local.json" },
      writeOverlay: () => {
        throw new Error("EROFS: read-only file system");
      },
    });
    expect(sync.materializedPath).toBeUndefined();
    expect(sync.materializationWarning).toContain("read-only");
    expect(
      new CustomProviderRegistry(sync.overlay).lookup("db-only")?.baseUrl,
    ).toBe("https://db-only.example/v1");
  });
});

describe("add_custom_provider with an api_key, through the tool", () => {
  const SECRET = "sk-test-plaintext-must-appear-nowhere";

  function harness() {
    const dir = mkdtempSync(join(tmpdir(), "custom-providers-tool-"));
    const path = join(dir, "providers.local.json");
    const env = { CUSTOM_PROVIDERS_PATH: path };
    const store = new InMemoryCustomProviderStore();
    const vault = new Map<string, string>();
    const credentialAdmin = {
      create: async (input: CredentialInput) => {
        vault.set(
          `${input.kind}:${input.provider}:${input.keyId}`,
          await encryptSecret(encryptionKey, input.plaintext),
        );
        return { id: "credential-1" };
      },
    };
    const registry = new CustomProviderRegistry({ providers: [], bots: {} });
    const tools: PlatformTools = {
      actorIsAdmin: async () => true,
      actorEmail: async () => "admin@example.test",
      addMcpServer: async () => {
        throw new Error("not used");
      },
      installSkill: async () => {
        throw new Error("not used");
      },
      providerExists: (id) => registry.exists(id),
      addAgent: async () => {
        throw new Error("not used");
      },
      addCustomProvider: async (actorId, input) => {
        const outcome = await registerChatCustomProvider(
          { store, credentialAdmin, env },
          { actorId, actorLabel: "admin@example.test", ...input },
        );
        registry.replace(outcome.overlay);
        const { overlay: _overlay, ...result } = outcome;
        return result;
      },
    };
    return { path, store, vault, registry, tools };
  }

  test("the provider and its key land durably, and the plaintext is in no artifact", async () => {
    const { path, store, vault, registry, tools } = harness();
    usePlatformTools(tools);
    const result = await callTool(CONNECTION, "add_custom_provider", {
      id: "acme-router",
      label: "Acme",
      base_url: "https://acme.example/v1",
      api_key: SECRET,
      default_model: "acme-1",
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("custom_providers");
    expect(result.text).toContain("survives restarts and redeploys");
    expect(result.text).toContain("active from the next server start");

    // The registry row: durable store, derived key variable, and no key material anywhere.
    const records = await store.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "acme-router",
      baseUrl: "https://acme.example/v1",
      keyVariable: "ACME_ROUTER_API_KEY",
      defaultModel: "acme-1",
      createdBy: "admin@example.test",
    });
    const materialized = readFileSync(path, "utf-8");
    expect(materialized).toContain("https://acme.example/v1");
    expect(registry.exists("acme-router")).toBe(true);

    // The vault holds exactly one entry, under the derived coordinates, encrypted.
    expect([...vault.keys()]).toEqual(["model:custom-provider:acme-router"]);
    const envelope = [...vault.values()][0];
    expect(await decryptSecret(encryptionKey, envelope)).toBe(SECRET);

    // The plaintext appears in NO artifact the add produced.
    const artifacts = [
      result.text,
      store.dump(),
      materialized,
      JSON.stringify([...vault.entries()]),
      JSON.stringify(records),
    ];
    for (const artifact of artifacts) {
      expect(artifact).not.toContain(SECRET);
    }

    // Resolution: environment under the derived variable wins; the vault is the fallback.
    const reader = {
      readModelSecret: async (input: { provider: string; keyId: string }) =>
        input.provider === "custom-provider" && input.keyId === "acme-router"
          ? { encryptedValue: envelope }
          : null,
    };
    expect(
      await resolveModelApiKey({
        encryptionKey,
        provider: "openai",
        keyId: "primary-model",
        keyVariable: "ACME_ROUTER_API_KEY",
        customProviderId: "acme-router",
        reader,
        environment: { ACME_ROUTER_API_KEY: " env-wins " },
      }),
    ).toBe("env-wins");
    expect(
      await resolveModelApiKey({
        encryptionKey,
        provider: "openai",
        keyId: "primary-model",
        keyVariable: "ACME_ROUTER_API_KEY",
        customProviderId: "acme-router",
        reader,
        environment: {},
      }),
    ).toBe(SECRET);
  });

  test("without an api_key the key variable path is unchanged and no vault entry is written", async () => {
    const { store, vault, tools } = harness();
    usePlatformTools(tools);
    const result = await callTool(CONNECTION, "add_custom_provider", {
      id: "env-router",
      label: "Env Router",
      base_url: "https://env-router.example/v1",
      key_variable: "ENV_ROUTER_API_KEY",
      default_model: "auto:default",
    });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("read from ENV_ROUTER_API_KEY");
    expect(vault.size).toBe(0);
    expect((await store.list())[0]?.keyVariable).toBe("ENV_ROUTER_API_KEY");
  });
});
