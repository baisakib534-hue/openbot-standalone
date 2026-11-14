import { Hono, type MiddlewareHandler } from "hono";
import type { AppVariables } from "../auth/guards";
import type { ThreadIdentity } from "../channels/thread-identity";
import {
  PageConflictError,
  PageNotFoundError,
  SpaceNotFoundError,
  SpaceRefusedError,
  type SpaceStore,
} from "./store";

/**
 * The HTTP surface for Spaces, in the shape of the neighbouring route modules: a factory taking
 * the store and the deployment's `requireUser`, every handler owner-scoped through the store,
 * and the store's errors mapped in one place — not found 404, a stale revision 409, a refusal
 * 400. Limits are OpenDots' own: a title is 160 characters, a page 100,000, a space name 60.
 */

const MAX_TITLE = 160;
const MAX_CONTENT = 100_000;
const MAX_SPACE_NAME = 60;
const MAX_DESCRIPTION = 500;

type Body = Record<string, unknown> | null;

function textField(
  body: Body,
  key: string,
  max: number,
): string | undefined | null {
  const value = body?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : null;
}

function mapStoreError(
  context: { json: (body: unknown, status: number) => Response },
  error: unknown,
): Response {
  if (error instanceof SpaceNotFoundError || error instanceof PageNotFoundError) {
    return context.json({ error: (error as Error).message }, 404);
  }
  if (error instanceof PageConflictError) {
    return context.json({ error: error.message }, 409);
  }
  if (error instanceof SpaceRefusedError) {
    return context.json({ error: error.message }, 400);
  }
  throw error;
}

export function createSpaceRoutes(
  store: SpaceStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  options: { threadIdentity?: ThreadIdentity } = {},
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  const actorId = (context: { var: AppVariables }) => context.var.actor.id;
  const actorEmail = (context: { var: AppVariables }) => context.var.actor.email;

  routes.get("/", requireUser, async (context) => {
    return context.json({ spaces: await store.listSpaces(actorId(context)) });
  });

  routes.post("/", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as Body;
    const name = textField(body, "name", MAX_SPACE_NAME);
    const description = body?.description;
    if (
      name === undefined ||
      name === null ||
      (description !== undefined &&
        (typeof description !== "string" || description.length > MAX_DESCRIPTION))
    ) {
      return context.json(
        { error: "A name (60 characters max) and a description (500 max) are required." },
        400,
      );
    }
    const space = await store.createSpace(actorId(context), {
      name,
      description: typeof description === "string" ? description : "",
    });
    return context.json({ space }, 201);
  });

  routes.patch("/:spaceId", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as Body;
    const name = textField(body, "name", MAX_SPACE_NAME);
    const description = body?.description;
    if (
      name === null ||
      (description !== undefined &&
        (typeof description !== "string" || description.length > MAX_DESCRIPTION))
    ) {
      return context.json({ error: "That is not a name or description I can save." }, 400);
    }
    try {
      const space = await store.updateSpace(actorId(context), context.req.param("spaceId"), {
        ...(name !== undefined ? { name } : {}),
        ...(typeof description === "string" ? { description } : {}),
      });
      return context.json({ space });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.delete("/:spaceId", requireUser, async (context) => {
    try {
      await store.deleteSpace(actorId(context), context.req.param("spaceId"));
      return context.json({ ok: true });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.get("/:spaceId/pages", requireUser, async (context) => {
    try {
      const list = await store.listPages(actorId(context), context.req.param("spaceId"));
      return context.json({ pages: list });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:spaceId/pages", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as Body;
    const title = textField(body, "title", MAX_TITLE);
    const content = body?.content;
    const parentId = body?.parentId;
    const sourceThreadId = body?.sourceThreadId;
    const editorState = body?.editorState;
    if (
      title === undefined ||
      title === null ||
      (content !== undefined && (typeof content !== "string" || content.length > MAX_CONTENT)) ||
      (parentId !== undefined && parentId !== null && typeof parentId !== "string") ||
      (sourceThreadId !== undefined && sourceThreadId !== null && typeof sourceThreadId !== "string") ||
      (editorState !== undefined &&
        editorState !== null &&
        (typeof editorState !== "object" || Array.isArray(editorState)))
    ) {
      return context.json(
        { error: "Enter a title (160 characters max) and Markdown content (100,000 max)." },
        400,
      );
    }
    try {
      const page = await store.createPage(actorId(context), context.req.param("spaceId"), {
        title,
        content: typeof content === "string" ? content : "",
        ...(editorState !== undefined
          ? { editorState: editorState as Record<string, unknown> | null }
          : {}),
        parentId: typeof parentId === "string" ? parentId : null,
        sourceThreadId: typeof sourceThreadId === "string" ? sourceThreadId : null,
        by: actorEmail(context),
      });
      return context.json({ page }, 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.get("/:spaceId/pages/:pageId", requireUser, async (context) => {
    const page = await store.getPage(
      actorId(context),
      context.req.param("spaceId"),
      context.req.param("pageId"),
    );
    if (!page) return context.json({ error: "Page not found in this Space." }, 404);
    return context.json({ page });
  });

  routes.patch("/:spaceId/pages/:pageId", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as Body;
    const expectedRevision = body?.expectedRevision;
    const title = textField(body, "title", MAX_TITLE);
    const content = body?.content;
    const parentId = body?.parentId;
    const editorState = body?.editorState;
    if (
      typeof expectedRevision !== "number" ||
      !Number.isInteger(expectedRevision) ||
      expectedRevision < 1 ||
      title === null ||
      (content !== undefined && (typeof content !== "string" || content.length > MAX_CONTENT)) ||
      (parentId !== undefined && parentId !== null && typeof parentId !== "string") ||
      (editorState !== undefined &&
        editorState !== null &&
        (typeof editorState !== "object" || Array.isArray(editorState)))
    ) {
      return context.json(
        { error: "A save needs the revision it was written against, and a title/content within their limits." },
        400,
      );
    }
    try {
      const page = await store.updatePage(
        actorId(context),
        context.req.param("spaceId"),
        context.req.param("pageId"),
        {
          expectedRevision,
          ...(title !== undefined ? { title } : {}),
          ...(typeof content === "string" ? { content } : {}),
          ...(editorState !== undefined
            ? { editorState: editorState as Record<string, unknown> | null }
            : {}),
          ...(parentId !== undefined
            ? { parentId: typeof parentId === "string" ? parentId : null }
            : {}),
        },
      );
      return context.json({ page });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.delete("/:spaceId/pages/:pageId", requireUser, async (context) => {
    try {
      await store.deletePage(
        actorId(context),
        context.req.param("spaceId"),
        context.req.param("pageId"),
      );
      return context.json({ ok: true });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.get("/:spaceId/grants", requireUser, async (context) => {
    try {
      const agentIds = await store.grantedAgentIds(actorId(context), context.req.param("spaceId"));
      return context.json({ agentIds });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.post("/:spaceId/grants", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as Body;
    const agentId = body?.agentId;
    if (typeof agentId !== "string" || !agentId.trim()) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    try {
      await store.grantSpace(
        actorId(context),
        context.req.param("spaceId"),
        agentId.trim(),
        actorEmail(context),
      );
      const agentIds = await store.grantedAgentIds(actorId(context), context.req.param("spaceId"));
      return context.json({ agentIds });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  routes.delete("/:spaceId/grants/:agentId", requireUser, async (context) => {
    try {
      await store.revokeSpace(
        actorId(context),
        context.req.param("spaceId"),
        context.req.param("agentId"),
        actorEmail(context),
      );
      const agentIds = await store.grantedAgentIds(actorId(context), context.req.param("spaceId"));
      return context.json({ agentIds });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /**
   * The conversation a page and a Bot share. Minted once through the deployment's thread
   * identity and bound in the store, so reopening the page's chat continues the same thread —
   * an ordinary Bot thread in every other respect, in local mode exactly as upstream.
   */
  routes.post("/:spaceId/pages/:pageId/conversation", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as Body;
    const agentId = body?.agentId;
    if (typeof agentId !== "string" || !agentId.trim()) {
      return context.json({ error: "A Bot id is required." }, 400);
    }
    const spaceId = context.req.param("spaceId");
    const pageId = context.req.param("pageId");
    try {
      const page = await store.getPage(actorId(context), spaceId, pageId);
      if (!page) return context.json({ error: "Page not found in this Space." }, 404);
      if (!(await store.canAccess(agentId.trim(), spaceId))) {
        return context.json(
          { error: "Choose a Bot in this Space with access enabled." },
          400,
        );
      }
      let threadId = await store.threadFor(pageId, agentId.trim());
      if (!threadId) {
        if (!options.threadIdentity) {
          return context.json({ error: "Conversations are not available in this deployment." }, 503);
        }
        threadId = options.threadIdentity.mint();
        await store.bindThread(pageId, agentId.trim(), threadId);
      }
      return context.json({ threadId, pageId, spaceId, agentId: agentId.trim() });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  /**
   * Land a draft the person approved in the review card. The receipt in the store makes the
   * approval idempotent; the Bot whose thread this is must still hold its grant to the space
   * the draft is aimed at.
   */
  routes.post("/:spaceId/pages/reviewed", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as Body;
    const threadId = body?.threadId;
    const toolCallId = body?.toolCallId;
    const title = textField(body, "title", MAX_TITLE);
    const content = body?.content;
    if (
      typeof threadId !== "string" ||
      !threadId ||
      typeof toolCallId !== "string" ||
      !toolCallId ||
      title === undefined ||
      title === null ||
      typeof content !== "string" ||
      content.length < 1 ||
      content.length > MAX_CONTENT
    ) {
      return context.json({ error: "A reviewed draft needs its thread, its review id, a title and content." }, 400);
    }
    const spaceId = context.req.param("spaceId");
    try {
      const bound = await store.pageForThread(threadId);
      if (!bound) {
        return context.json({ error: "That conversation is not a page conversation." }, 400);
      }
      if (!(await store.canAccess(bound.agentId, spaceId))) {
        return context.json(
          { error: "This Bot no longer has access to the selected Space." },
          403,
        );
      }
      const result = await store.createReviewed(actorId(context), spaceId, {
        threadId,
        toolCallId,
        title,
        content,
        by: actorEmail(context),
      });
      if (!result.page) return context.json({ deleted: true, alreadySaved: true });
      return context.json({ page: result.page, alreadySaved: result.alreadySaved }, result.alreadySaved ? 200 : 201);
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  return routes;
}
