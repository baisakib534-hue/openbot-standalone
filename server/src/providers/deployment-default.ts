import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { enterpriseSettings } from "../db/schema";

/**
 * The deployment's default model provider, chosen INSIDE the app — the PicoClaw shape of the
 * thing: one provider + one model, picked once, and every built-in Bot simply runs on it.
 *
 * Stored as one row of the deployment's existing enterprise-settings table (key
 * `default_model_provider`, value `{ value: { provider, model } }` — the envelope that table's
 * store writes), so no new table or migration exists for what is a single fact. Absent row =
 * no in-app default, and selection falls back to the environment, then to the tenant package.
 *
 * PRECEDENCE for provider + model selection (the one chain, highest first — see
 * `runtimeModelForEnvironment` and the key chains in `resolveModelApiKey`):
 *   1. this in-app deployment default (provider + model);
 *   2. BOT_PROVIDER / BOT_MODEL in the environment;
 *   3. the tenant package's own provider/model.
 * (The tenant package's stored credential is a KEY fact on the package's own provider path
 * only; it is never spent at a custom provider's endpoint — see credentials.ts.)
 * Step 2 must outrank step 3 or an in-app change could never take effect on a host whose
 * environment already pins a provider (a Render service with BOT_PROVIDER set is exactly
 * that host). It is applied by rewriting BOT_PROVIDER/BOT_MODEL in the environment the
 * runtime model is built from — {@link environmentWithDeploymentDefault} — so there stays
 * exactly one resolver and one chain to reason about.
 *
 * Like every provider selection, it is read at server start and applies from the next start;
 * the row is durable, so a restart or redeploy keeps the choice.
 */

export type DeploymentDefaultProvider = {
  provider: string;
  model: string;
};

export type DeploymentDefaultStore = {
  get(): Promise<DeploymentDefaultProvider | null>;
  set(value: DeploymentDefaultProvider, by: string | null): Promise<void>;
  clear(): Promise<void>;
};

export const DEPLOYMENT_DEFAULT_KEY = "default_model_provider";

function parseDefault(value: unknown): DeploymentDefaultProvider | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const inner = (value as { value?: unknown }).value;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) return null;
  const provider = (inner as { provider?: unknown }).provider;
  const model = (inner as { model?: unknown }).model;
  if (typeof provider !== "string" || provider.trim() === "") return null;
  if (typeof model !== "string" || model.trim() === "") return null;
  return { provider: provider.trim().toLowerCase(), model: model.trim() };
}

export function createDeploymentDefaultStore(
  database: Database,
): DeploymentDefaultStore {
  return {
    async get() {
      const [row] = await database
        .select({ value: enterpriseSettings.value })
        .from(enterpriseSettings)
        .where(eq(enterpriseSettings.key, DEPLOYMENT_DEFAULT_KEY))
        .limit(1);
      return parseDefault(row?.value);
    },

    async set(value, by) {
      const stored = {
        value: { provider: value.provider, model: value.model },
      };
      await database
        .insert(enterpriseSettings)
        .values({
          key: DEPLOYMENT_DEFAULT_KEY,
          value: stored,
          updatedBy: by,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: enterpriseSettings.key,
          set: { value: stored, updatedBy: by, updatedAt: new Date() },
        });
    },

    async clear() {
      await database
        .delete(enterpriseSettings)
        .where(eq(enterpriseSettings.key, DEPLOYMENT_DEFAULT_KEY));
    },
  };
}

/** The same store contract without a database, for tests and local verification. */
export class InMemoryDeploymentDefaultStore implements DeploymentDefaultStore {
  private current: DeploymentDefaultProvider | null;

  constructor(initial: DeploymentDefaultProvider | null = null) {
    this.current = initial;
  }

  async get(): Promise<DeploymentDefaultProvider | null> {
    return this.current ? { ...this.current } : null;
  }

  async set(value: DeploymentDefaultProvider): Promise<void> {
    this.current = { ...value };
  }

  async clear(): Promise<void> {
    this.current = null;
  }
}

/**
 * The environment the runtime model is built from, with the in-app default applied over it.
 *
 * BOT_PROVIDER/BOT_MODEL are rewritten, nothing else is touched, and with no stored default
 * the environment passes through unchanged — one resolver (`runtimeModelForEnvironment`)
 * serves every case, and the precedence in this module's header is just the order in which
 * the layers were applied before it ran.
 */
export function environmentWithDeploymentDefault(
  environment: Record<string, string | undefined>,
  deploymentDefault: DeploymentDefaultProvider | null,
): Record<string, string | undefined> {
  if (!deploymentDefault) return environment;
  return {
    ...environment,
    BOT_PROVIDER: deploymentDefault.provider,
    BOT_MODEL: deploymentDefault.model,
  };
}
