/**
 * The Providers list, in a fresh process whose environment is a production deployment's.
 *
 * A unit test in the suite's own process cannot reproduce the live page's duplication:
 * the shared module folds the process overlay into MODEL_PROVIDERS at load, and the
 * suite's process carries no CUSTOM_PROVIDERS_JSON. This fixture runs where the bug
 * lived — a process started with the deployment's environment (flat
 * CUSTOM_PROVIDERS_JSON, a materialized overlay file at CUSTOM_PROVIDERS_PATH,
 * BOT_PROVIDER/BOT_MODEL pinned) — builds the service the way index.ts wires it
 * (registry from the merged sync, empty durable stores), and prints the list and the
 * effective default as JSON for the test to assert on.
 */
import {
  CustomProviderRegistry,
  InMemoryCustomProviderStore,
  syncCustomProvidersOverlay,
} from "../../src/providers/custom-providers";
import { InMemoryDeploymentDefaultStore } from "../../src/providers/deployment-default";
import { createProvidersService } from "../../src/providers/service";

const store = new InMemoryCustomProviderStore();
const sync = await syncCustomProvidersOverlay({ store, env: process.env });
const service = createProvidersService({
  store,
  registry: new CustomProviderRegistry(sync.overlay),
  credentialReader: { readModelSecret: async () => null },
  deploymentDefaultStore: new InMemoryDeploymentDefaultStore(),
  env: process.env,
});

const [providers, effectiveDefault] = await Promise.all([
  service.list(),
  service.effectiveDefault(),
]);
console.log(JSON.stringify({ providers, effectiveDefault }));
