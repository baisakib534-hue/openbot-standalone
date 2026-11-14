import { Hono, type MiddlewareHandler } from "hono";
import { requireAdmin, type AppVariables } from "../auth/guards";
import { ProviderRefusedError, type ProvidersService } from "./service";

/**
 * The HTTP surface for Providers, behind the same two gates as every neighbouring admin
 * surface: `requireUser` on the route group, `requireAdmin` inside each handler. Keys are
 * write-only — a create may carry `api_key`, no response ever contains one; replacing a key
 * is posting the provider again with a new one. Every act goes through the Providers service,
 * the same implementation the Platform Tools call, so the page and the chat cannot disagree
 * about what a provider is.
 */

type Body = Record<string, unknown> | null;

function textField(body: Body, key: string): string | undefined {
  const value = body?.[key];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

export function createProviderRoutes(
  service: ProvidersService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const actorId = (context: { var: AppVariables }) => context.var.actor.id;
  const actorLabel = (context: { var: AppVariables }) =>
    context.var.actor.email ?? context.var.actor.id;

  routes.get("/", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const [providers, deploymentDefault, effectiveDefault] = await Promise.all([
      service.list(),
      service.deploymentDefault(),
      service.effectiveDefault(),
    ]);
    return context.json({ providers, deploymentDefault, effectiveDefault });
  });

  routes.post("/", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const body = (await context.req.json().catch(() => null)) as Body;
    const id = textField(body, "id");
    const label = textField(body, "label");
    const baseUrl = textField(body, "base_url");
    const defaultModel = textField(body, "default_model");
    const keyVariable = textField(body, "key_variable");
    const apiKey = textField(body, "api_key");
    if (!id || !label || !baseUrl || !defaultModel || (!keyVariable && !apiKey)) {
      return context.json(
        {
          error:
            "A provider needs an id, a label, a base_url, a default_model, and its key: either api_key itself or the key_variable its key arrives in.",
        },
        400,
      );
    }
    try {
      const outcome = await service.add({
        actorId: actorId(context),
        actorLabel: actorLabel(context),
        id,
        label,
        baseUrl,
        defaultModel,
        ...(keyVariable ? { keyVariable } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(body?.use_as_default === true ? { useAsDefault: true } : {}),
        ...(textField(body, "model") ? { model: textField(body, "model") } : {}),
      });
      return context.json({ provider: outcome }, 201);
    } catch (error) {
      return context.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  });

  routes.post("/default", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    const body = (await context.req.json().catch(() => null)) as Body;
    const provider = textField(body, "provider");
    if (!provider) {
      return context.json({ error: "A provider id is required." }, 400);
    }
    try {
      const deploymentDefault = await service.setDefault({
        provider,
        ...(textField(body, "model") ? { model: textField(body, "model") } : {}),
        actorLabel: actorLabel(context),
      });
      return context.json({ deploymentDefault });
    } catch (error) {
      const status = error instanceof ProviderRefusedError ? 400 : 500;
      return context.json(
        { error: error instanceof Error ? error.message : String(error) },
        status,
      );
    }
  });

  routes.delete("/:id", requireUser, async (context) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    try {
      const result = await service.remove(context.req.param("id"));
      return context.json({ removed: true, ...result });
    } catch (error) {
      const status = error instanceof ProviderRefusedError ? 400 : 500;
      return context.json(
        { error: error instanceof Error ? error.message : String(error) },
        status,
      );
    }
  });

  return routes;
}
