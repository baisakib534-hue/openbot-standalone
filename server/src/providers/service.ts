import {
  MODEL_PROVIDERS,
  readCustomProvidersEnvOverlay,
  readCustomProvidersFileOverlay,
  writeCustomProvidersOverlayFile,
  type CustomProvidersOverlay,
  type ProviderSpec,
} from "../../../shared/model-providers";
import {
  CUSTOM_PROVIDER_CREDENTIAL_PROVIDER,
  customProviderCredentialKeyId,
  type ModelCredentialSecretReader,
} from "../credentials";
import {
  registerChatCustomProvider,
  syncCustomProvidersOverlay,
  type CustomProviderRegistry,
  type CustomProviderStore,
  type ProviderCredentialWriter,
} from "./custom-providers";
import type {
  DeploymentDefaultProvider,
  DeploymentDefaultStore,
} from "./deployment-default";

/**
 * The Providers service: ONE implementation behind both doors to the same room — the admin
 * HTTP routes (`/api/providers`, the Providers page) and the Platform Tools
 * (`add_custom_provider`, `set_default_provider`). A provider added by either is validated by
 * the loaders' own rules, stored in the same Postgres overlay, keyed into the same encrypted
 * vault, registered in the same live registry, and the deployment default lives in the same
 * store whichever door set it. Nothing here returns a key value, ever: keys are write-only,
 * and a list row says only whether one is present.
 */

export type ProviderSource = "builtin" | "env" | "file" | "db";

export type ProviderRowView = {
  id: string;
  label: string;
  /** The endpoint the row names; null for a built-in whose endpoint arrives by variable. */
  baseUrl: string | null;
  defaultModel: string;
  keyVariable: string;
  source: ProviderSource;
  /** Whether a usable key is present (environment variable set, or a vault credential). */
  keyPresent: boolean;
  /** True when this row is the deployment default chosen in the app. */
  isDefault: boolean;
};

export type AddProviderInput = {
  actorId: string;
  actorLabel: string;
  id: string;
  label: string;
  baseUrl: string;
  keyVariable?: string;
  defaultModel: string;
  apiKey?: string;
  /** Also make this provider the deployment default (model: `model` or the row's default). */
  useAsDefault?: boolean;
  model?: string;
};

export type AddProviderOutcome = {
  id: string;
  keyVariable: string;
  credentialStored: boolean;
  materializedPath?: string;
  defaultSet?: DeploymentDefaultProvider;
};

export type ProvidersService = {
  list(): Promise<ProviderRowView[]>;
  add(input: AddProviderInput): Promise<AddProviderOutcome>;
  setDefault(input: {
    provider: string;
    model?: string;
    actorLabel: string;
  }): Promise<DeploymentDefaultProvider>;
  remove(id: string): Promise<{ clearedDefault: boolean }>;
  deploymentDefault(): Promise<DeploymentDefaultProvider | null>;
};

export class ProviderRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRefusedError";
  }
}

export function createProvidersService(deps: {
  store: CustomProviderStore;
  registry: CustomProviderRegistry;
  credentialAdmin?: ProviderCredentialWriter;
  credentialReader: ModelCredentialSecretReader;
  deploymentDefaultStore: DeploymentDefaultStore;
  env?: Readonly<Record<string, string | undefined>>;
}): ProvidersService {
  const env = deps.env ?? process.env;

  const sourceOf = async (id: string): Promise<ProviderSource> => {
    if (Object.hasOwn(MODEL_PROVIDERS, id)) return "builtin";
    if (readCustomProvidersEnvOverlay(env).providers.some((spec) => spec.id === id))
      return "env";
    if ((await deps.store.list()).some((record) => record.id === id)) return "db";
    if (readCustomProvidersFileOverlay(env).providers.some((spec) => spec.id === id))
      return "file";
    return "db";
  };

  const keyPresent = async (spec: ProviderSpec): Promise<boolean> => {
    if (env[spec.keyVariable]?.trim()) return true;
    if (Object.hasOwn(MODEL_PROVIDERS, spec.id)) return false;
    const stored = await deps.credentialReader.readModelSecret({
      provider: CUSTOM_PROVIDER_CREDENTIAL_PROVIDER,
      keyId: customProviderCredentialKeyId(spec.id),
    });
    return stored !== null;
  };

  const toView = async (
    spec: ProviderSpec,
    currentDefault: DeploymentDefaultProvider | null,
  ): Promise<ProviderRowView> => ({
    id: spec.id,
    label: spec.label,
    baseUrl: spec.baseUrl ?? null,
    defaultModel: spec.defaultModel,
    keyVariable: spec.keyVariable,
    source: await sourceOf(spec.id),
    keyPresent: await keyPresent(spec),
    isDefault: currentDefault?.provider === spec.id,
  });

  const service: ProvidersService = {
    async list() {
      const currentDefault = await deps.deploymentDefaultStore.get();
      const builtins = Object.values(MODEL_PROVIDERS);
      const customs = deps.registry.customProviders();
      return Promise.all(
        [...builtins, ...customs].map((spec) => toView(spec, currentDefault)),
      );
    },

    async add(input) {
      const outcome = await registerChatCustomProvider(
        {
          store: deps.store,
          ...(deps.credentialAdmin
            ? { credentialAdmin: deps.credentialAdmin }
            : {}),
          env,
        },
        {
          actorId: input.actorId,
          actorLabel: input.actorLabel,
          id: input.id,
          label: input.label,
          baseUrl: input.baseUrl,
          ...(input.keyVariable ? { keyVariable: input.keyVariable } : {}),
          ...(input.apiKey ? { apiKey: input.apiKey } : {}),
          defaultModel: input.defaultModel,
        },
      );
      deps.registry.replace(outcome.overlay);
      const { overlay: _overlay, ...result } = outcome;
      if (!input.useAsDefault) return result;
      const defaultSet = await service.setDefault({
        provider: outcome.id,
        ...(input.model ? { model: input.model } : {}),
        actorLabel: input.actorLabel,
      });
      return { ...result, defaultSet };
    },

    async setDefault(input) {
      const spec = deps.registry.lookup(input.provider);
      if (!spec) {
        throw new ProviderRefusedError(
          `There is no provider registered as "${input.provider}". Add it first, then set it as the default.`,
        );
      }
      const model = input.model?.trim() || spec.defaultModel;
      if (!model) {
        throw new ProviderRefusedError(
          `Provider "${spec.id}" names no default model, so one must be given to set it as the default.`,
        );
      }
      const value = { provider: spec.id, model };
      await deps.deploymentDefaultStore.set(value, input.actorLabel);
      return value;
    },

    async remove(id) {
      const normalized = id.trim().toLowerCase();
      if (Object.hasOwn(MODEL_PROVIDERS, normalized)) {
        throw new ProviderRefusedError(
          `"${normalized}" is a built-in provider; it cannot be deleted.`,
        );
      }
      const inDb = (await deps.store.list()).some(
        (record) => record.id === normalized,
      );
      if (!inDb) {
        const source = await sourceOf(normalized);
        if (deps.registry.exists(normalized)) {
          throw new ProviderRefusedError(
            `"${normalized}" comes from the ${source === "env" ? "environment (CUSTOM_PROVIDERS_JSON)" : "overlay file"}, not from the app, so it cannot be deleted here — remove it from that source instead.`,
          );
        }
        throw new ProviderRefusedError(
          `There is no provider registered as "${normalized}".`,
        );
      }
      await deps.store.remove(normalized);
      const sync = await syncCustomProvidersOverlay({ store: deps.store, env });
      /*
       * The overlay file the sync just merged is partly a CACHE of the previous merge —
       * materialization writes database rows into it — so a row deleted from the database
       * would be resurrected from that cache on this sync and every later one. Drop the id
       * from the merged result and re-materialize, making the deletion the last word the
       * file carries. A row the ENVIRONMENT defines is not the cache's doing: it outranks
       * the database, stays registered, and the source check above already refused only
       * when the database held no row at all.
       */
      const definedByEnv = readCustomProvidersEnvOverlay(env).providers.some(
        (spec) => spec.id === normalized,
      );
      if (definedByEnv) {
        deps.registry.replace(sync.overlay);
      } else {
        const filtered: CustomProvidersOverlay = {
          providers: sync.overlay.providers.filter(
            (spec) => spec.id !== normalized,
          ),
          bots: sync.overlay.bots,
        };
        deps.registry.replace(filtered);
        try {
          writeCustomProvidersOverlayFile(filtered, env);
        } catch {
          // The in-process registry is already correct; a later sync rewrites the file.
        }
      }
      const currentDefault = await deps.deploymentDefaultStore.get();
      const clearedDefault = currentDefault?.provider === normalized;
      if (clearedDefault) await deps.deploymentDefaultStore.clear();
      return { clearedDefault };
    },

    async deploymentDefault() {
      return deps.deploymentDefaultStore.get();
    },
  };

  return service;
}
