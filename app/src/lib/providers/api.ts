import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * Model providers, as the server holds them (see server/src/providers). A row says whether a
 * key is present, never what it is: keys are write-only, and replacing one is posting the
 * provider again with a new `api_key`.
 */

export type ProviderSource = "builtin" | "env" | "file" | "db";

export type ProviderRow = {
  id: string;
  label: string;
  baseUrl: string | null;
  defaultModel: string;
  keyVariable: string;
  source: ProviderSource;
  keyPresent: boolean;
  isDefault: boolean;
  /** Where the effective default came from when this row is it; null otherwise. */
  defaultOrigin: "db" | "env" | null;
};

export type DeploymentDefault = { provider: string; model: string };

/** The default the deployment runs on, and which layer supplied it. */
export type EffectiveDefault = DeploymentDefault & { origin: "db" | "env" };

export type ProvidersResponse = {
  providers: ProviderRow[];
  deploymentDefault: DeploymentDefault | null;
  effectiveDefault: EffectiveDefault | null;
};

export const providerKeys = {
  providers: ["providers"] as const,
};

export function providersQueryOptions() {
  return queryOptions({
    queryKey: providerKeys.providers,
    queryFn: async (): Promise<ProvidersResponse> => {
      const response = await client("/api/providers", {
        fallback: "Could not load providers.",
      });
      return (await response.json()) as ProvidersResponse;
    },
  });
}

export type AddProviderValues = {
  id: string;
  label: string;
  base_url: string;
  default_model: string;
  api_key?: string;
  key_variable?: string;
  use_as_default?: boolean;
  model?: string;
};

export function addProvider(values: AddProviderValues) {
  return client("/api/providers", {
    method: "POST",
    body: values,
    fallback: "Could not add that provider.",
  });
}

export function setDefaultProvider(provider: string, model?: string) {
  return client("/api/providers/default", {
    method: "POST",
    body: { provider, ...(model ? { model } : {}) },
    fallback: "Could not set the default provider.",
  });
}

export function removeProvider(id: string) {
  return client(`/api/providers/${encodeURIComponent(id)}`, {
    method: "DELETE",
    fallback: "Could not delete that provider.",
  });
}

/** The badge word for where a row came from. */
export function providerSourceLabel(source: ProviderSource): string {
  switch (source) {
    case "builtin":
      return "Built-in";
    case "env":
      return "Env";
    case "file":
      return "File";
    case "db":
      return "Added in app";
  }
}

/** A provider id suggested from its label: lower-case, hyphens, like every id rule here. */
export function suggestProviderId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
