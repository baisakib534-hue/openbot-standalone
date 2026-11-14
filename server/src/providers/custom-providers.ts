import { asc, eq } from "drizzle-orm";
import {
  defaultKeyVariableForCustomProvider,
  mergeCustomProvidersOverlays,
  MODEL_PROVIDERS,
  parseCustomProvidersOverlay,
  PROVIDER_IDS,
  readCustomProvidersEnvOverlay,
  readCustomProvidersFileOverlay,
  writeCustomProvidersOverlayFile,
  customProviderFromRow,
  type CustomProvidersOverlay,
  type ProviderSpec,
} from "../../../shared/model-providers";
import {
  CUSTOM_PROVIDER_CREDENTIAL_PROVIDER,
  customProviderCredentialKeyId,
  type CredentialInput,
} from "../credentials";
import type { Database } from "../db/client";
import { customProviders } from "../db/schema";

/**
 * Durable custom providers: the database overlay between the file and the environment.
 *
 * The registry's sources, in ascending precedence, are the overlay file, this table, and
 * `CUSTOM_PROVIDERS_JSON` — environment > database > file. The table is what makes a provider
 * added from chat survive a restart on an ephemeral filesystem: on boot the server reads these
 * rows, merges them with the other sources, and materializes the result back to the overlay
 * file the TypeScript and Python loaders already read. The materialized rows name a key
 * variable only; key values live in the credential vault, never here and never in the file.
 */

export type CustomProviderRecord = {
  id: string;
  label: string;
  baseUrl: string;
  keyVariable: string;
  defaultModel: string;
  api: string;
  baseUrlVariable: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CustomProviderInput = {
  id: string;
  label: string;
  baseUrl: string;
  keyVariable: string;
  defaultModel: string;
  api?: string;
  baseUrlVariable?: string;
  createdBy?: string | null;
};

export type CustomProviderStore = {
  list(): Promise<CustomProviderRecord[]>;
  upsert(input: CustomProviderInput): Promise<CustomProviderRecord>;
  /** Delete one row. False when no row by that id exists. */
  remove(id: string): Promise<boolean>;
};

/** Validate an input exactly as a loader validates an overlay row, and normalize it to a spec. */
export function customProviderSpecFromInput(
  input: CustomProviderInput,
): ProviderSpec {
  return customProviderFromRow("custom_providers database", input.id, {
    label: input.label,
    base_url: input.baseUrl,
    key_variable: input.keyVariable,
    base_url_variable: input.baseUrlVariable,
    default_model: input.defaultModel,
    api: input.api ?? "chat",
  });
}

function recordFromSpec(
  spec: ProviderSpec,
  createdBy: string | null,
  existing?: CustomProviderRecord,
): CustomProviderRecord {
  const now = new Date();
  return {
    id: spec.id,
    label: spec.label,
    baseUrl: spec.baseUrl ?? "",
    keyVariable: spec.keyVariable,
    defaultModel: spec.defaultModel,
    api: spec.api ?? "chat",
    baseUrlVariable: spec.baseUrlVariable,
    createdBy: existing?.createdBy ?? createdBy,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

type CustomProviderRow = typeof customProviders.$inferSelect;

function toRecord(row: CustomProviderRow): CustomProviderRecord {
  return {
    id: row.id,
    label: row.label,
    baseUrl: row.baseUrl,
    keyVariable: row.keyVariable,
    defaultModel: row.defaultModel,
    api: row.api,
    baseUrlVariable: row.baseUrlVariable,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createCustomProviderStore(
  database: Database,
): CustomProviderStore {
  return {
    async list() {
      const rows = await database
        .select()
        .from(customProviders)
        .orderBy(asc(customProviders.id));
      return rows.map(toRecord);
    },

    async upsert(input) {
      const spec = customProviderSpecFromInput(input);
      const values = {
        id: spec.id,
        label: spec.label,
        baseUrl: spec.baseUrl ?? "",
        keyVariable: spec.keyVariable,
        defaultModel: spec.defaultModel,
        api: spec.api ?? "chat",
        baseUrlVariable: spec.baseUrlVariable,
        createdBy: input.createdBy ?? null,
      };
      const [row] = await database
        .insert(customProviders)
        .values(values)
        .onConflictDoUpdate({
          target: customProviders.id,
          set: {
            label: values.label,
            baseUrl: values.baseUrl,
            keyVariable: values.keyVariable,
            defaultModel: values.defaultModel,
            api: values.api,
            baseUrlVariable: values.baseUrlVariable,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new Error("Custom provider could not be stored");
      return toRecord(row);
    },

    async remove(id) {
      const removed = await database
        .delete(customProviders)
        .where(eq(customProviders.id, id))
        .returning({ id: customProviders.id });
      return removed.length > 0;
    },
  };
}

/** The same store contract without a database, for tests and local verification. */
export class InMemoryCustomProviderStore implements CustomProviderStore {
  private readonly records = new Map<string, CustomProviderRecord>();

  constructor(initial: readonly CustomProviderInput[] = []) {
    for (const input of initial) {
      const spec = customProviderSpecFromInput(input);
      const record = recordFromSpec(spec, input.createdBy ?? null);
      this.records.set(record.id, record);
    }
  }

  async list(): Promise<CustomProviderRecord[]> {
    return [...this.records.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((record) => ({ ...record }));
  }

  async upsert(input: CustomProviderInput): Promise<CustomProviderRecord> {
    const spec = customProviderSpecFromInput(input);
    const record = recordFromSpec(
      spec,
      input.createdBy ?? null,
      this.records.get(spec.id),
    );
    this.records.set(record.id, record);
    return { ...record };
  }

  async remove(id: string): Promise<boolean> {
    return this.records.delete(id);
  }

  /** Everything the store holds, as one string — a test's way to prove a secret is absent. */
  dump(): string {
    return JSON.stringify([...this.records.values()]);
  }
}

/** Database rows as an overlay, through the loaders' own parser and validation. */
export function customProvidersOverlayFromRecords(
  records: readonly CustomProviderRecord[],
): CustomProvidersOverlay {
  const providers: Record<string, unknown> = {};
  for (const record of records) {
    providers[record.id] = {
      label: record.label,
      base_url: record.baseUrl,
      key_variable: record.keyVariable,
      base_url_variable: record.baseUrlVariable,
      default_model: record.defaultModel,
      api: record.api,
    };
  }
  return parseCustomProvidersOverlay(
    JSON.stringify({ providers }),
    "custom_providers database",
  );
}

export type CustomProviderSync = {
  overlay: CustomProvidersOverlay;
  /** Where the merged overlay was materialized, when the write succeeded. */
  materializedPath?: string;
  /** Why materialization was skipped, when the overlay path could not be written. */
  materializationWarning?: string;
};

/**
 * Read the database rows, merge file < database < environment, and materialize the result to
 * the overlay file for the processes that cannot read this server's database.
 *
 * A materialization failure is a warning, not a boot failure: the in-process registry below is
 * built from the merged overlay either way, so the server still sees every provider; only the
 * separate-process loaders would miss the database rows until a writable path is restored.
 */
export async function syncCustomProvidersOverlay(input: {
  store: CustomProviderStore;
  env?: Readonly<Record<string, string | undefined>>;
  writeOverlay?: (
    overlay: CustomProvidersOverlay,
    env: Readonly<Record<string, string | undefined>>,
  ) => string;
}): Promise<CustomProviderSync> {
  const env = input.env ?? process.env;
  const records = await input.store.list();
  const overlay = mergeCustomProvidersOverlays(
    readCustomProvidersFileOverlay(env),
    customProvidersOverlayFromRecords(records),
    readCustomProvidersEnvOverlay(env),
  );
  try {
    const materializedPath = (
      input.writeOverlay ?? writeCustomProvidersOverlayFile
    )(overlay, env);
    return { overlay, materializedPath };
  } catch (error) {
    const materializationWarning =
      error instanceof Error ? error.message : String(error);
    console.warn(
      JSON.stringify({
        type: "custom-providers-materialization-failed",
        warning: materializationWarning,
        note: "The server registry still uses the merged overlay; separate-process loaders may miss database providers until the overlay path is writable.",
      }),
    );
    return { overlay, materializationWarning };
  }
}

/**
 * The server's live view of the registry: the built-ins plus the merged overlay's customs.
 *
 * `runtimeModelForEnvironment` is handed this lookup instead of the shared module's load-time
 * one, so a boot that merged database rows — and a chat add that refreshed them — is what model
 * selection actually sees. Replacing the customs never touches the built-ins, and the already
 * constructed runtime model is not mutated: a provider added mid-run is registered here at
 * once, but the deployment's selected model still changes only on the next start.
 */
export class CustomProviderRegistry {
  private customs = new Map<string, ProviderSpec>();

  constructor(overlay: CustomProvidersOverlay) {
    this.replace(overlay);
  }

  replace(overlay: CustomProvidersOverlay): void {
    this.customs = new Map(
      overlay.providers.map((spec) => [spec.id, spec] as const),
    );
  }

  lookup(provider: string | undefined): ProviderSpec | undefined {
    const normalized = provider?.trim().toLowerCase() || "openai";
    const custom = this.customs.get(normalized);
    if (custom) return custom;
    return Object.hasOwn(MODEL_PROVIDERS, normalized)
      ? MODEL_PROVIDERS[normalized]
      : undefined;
  }

  exists(provider: string | undefined): boolean {
    const normalized = provider?.trim().toLowerCase();
    return (
      normalized !== undefined &&
      normalized !== "" &&
      this.lookup(normalized) !== undefined
    );
  }

  customProviders(): ProviderSpec[] {
    return [...this.customs.values()];
  }
}

/** Whether an id is one of the built-ins the overlay may never redefine. */
export function isBuiltInProviderId(id: string): boolean {
  return (PROVIDER_IDS as readonly string[]).includes(id);
}

/** The credential writer a chat registration needs — the credential admin service's shape. */
export type ProviderCredentialWriter = {
  create: (input: CredentialInput) => Promise<unknown>;
};

export type ChatCustomProviderResult = {
  id: string;
  keyVariable: string;
  credentialStored: boolean;
  materializedPath?: string;
  /** The merged overlay after this registration, for the caller's live registry refresh. */
  overlay: CustomProvidersOverlay;
};

/**
 * One chat registration, end to end — the implementation behind Platform Tools'
 * `add_custom_provider`, assembled here so the wiring in `index.ts` and its tests share it.
 *
 * Order matters. The row is validated before anything is written; the durable row and the
 * materialized overlay land next, so a failure after them leaves a registered provider a retry
 * can complete rather than a secret with nothing pointing at it; the key, when given, is stored
 * last, encrypted by the credential admin service under the coordinates derived from the
 * provider id. The key value is never written to the store, the overlay, or this result.
 */
export async function registerChatCustomProvider(
  deps: {
    store: CustomProviderStore;
    credentialAdmin?: ProviderCredentialWriter;
    env?: Readonly<Record<string, string | undefined>>;
    writeOverlay?: (
      overlay: CustomProvidersOverlay,
      env: Readonly<Record<string, string | undefined>>,
    ) => string;
  },
  input: {
    actorId: string;
    actorLabel: string;
    id: string;
    label: string;
    baseUrl: string;
    keyVariable?: string;
    defaultModel: string;
    apiKey?: string;
  },
): Promise<ChatCustomProviderResult> {
  const keyVariable =
    input.keyVariable ?? defaultKeyVariableForCustomProvider(input.id);
  // Validation first: a row the loaders would refuse must store nothing, key included.
  customProviderSpecFromInput({
    id: input.id,
    label: input.label,
    baseUrl: input.baseUrl,
    keyVariable,
    defaultModel: input.defaultModel,
    api: "chat",
  });
  await deps.store.upsert({
    id: input.id,
    label: input.label,
    baseUrl: input.baseUrl,
    keyVariable,
    defaultModel: input.defaultModel,
    api: "chat",
    createdBy: input.actorLabel,
  });
  const sync = await syncCustomProvidersOverlay({
    store: deps.store,
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.writeOverlay ? { writeOverlay: deps.writeOverlay } : {}),
  });
  let credentialStored = false;
  if (input.apiKey) {
    if (!deps.credentialAdmin) {
      throw new Error(
        "This deployment has no credential vault wired, so a provider key cannot be stored.",
      );
    }
    await deps.credentialAdmin.create({
      kind: "model",
      provider: CUSTOM_PROVIDER_CREDENTIAL_PROVIDER,
      keyId: customProviderCredentialKeyId(input.id),
      metadata: { source: "platform-tools" },
      plaintext: input.apiKey,
      actorUserId: input.actorId,
    });
    credentialStored = true;
  }
  return {
    id: input.id,
    keyVariable,
    credentialStored,
    ...(sync.materializedPath
      ? { materializedPath: sync.materializedPath }
      : {}),
    overlay: sync.overlay,
  };
}
