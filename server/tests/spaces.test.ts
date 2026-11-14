import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AppVariables } from "../src/auth/guards";
import type { ThreadIdentity } from "../src/channels/thread-identity";
import { createSpaceRoutes } from "../src/spaces/routes";
import {
  PageConflictError,
  PageNotFoundError,
  SpaceNotFoundError,
  SpaceRefusedError,
  type PageRecord,
  type SpaceRecord,
  type SpaceStore,
} from "../src/spaces/store";
import { pageContextText, spaceTools } from "../src/spaces/tools";

/**
 * Spaces, tested at the two seams that do not need a database: the HTTP routes and the Bot
 * tools, both against an in-memory store that implements the same contract the Drizzle store
 * does (owner scoping, revision conflicts, re-parenting deletes, grant checks, review
 * receipts). The Drizzle implementation itself is covered by typecheck and the migration; its
 * integration run needs the test Postgres, like every other store's.
 */

const OWNER = { id: "user-1", email: "owner@example.test", role: "admin" as const };
const OTHER = { id: "user-2", email: "other@example.test", role: "user" as const };

class FakeSpaceStore implements SpaceStore {
  spaces = new Map<string, SpaceRecord & { ownerUserId: string }>();
  pages = new Map<string, PageRecord>();
  grants = new Set<string>(); // `${spaceId}:${agentId}`
  threads = new Map<string, string>(); // `${pageId}:${agentId}` -> threadId
  reviews = new Map<
    string,
    { pageId: string; spaceId: string; title: string; content: string }
  >();
  private seq = 0;
  private id(prefix: string) {
    return `${prefix}-${++this.seq}`;
  }
  private now() {
    return new Date(1_700_000_000_000 + this.seq * 1000);
  }

  async createSpace(ownerUserId: string, input: { name: string; description: string }) {
    const space = {
      id: this.id("space"),
      ownerUserId,
      name: input.name,
      description: input.description,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.spaces.set(space.id, space);
    return space;
  }
  async listSpaces(ownerUserId: string) {
    return [...this.spaces.values()].filter((s) => s.ownerUserId === ownerUserId);
  }
  async getSpace(ownerUserId: string, spaceId: string) {
    const space = this.spaces.get(spaceId);
    return space && space.ownerUserId === ownerUserId ? space : null;
  }
  private async requireSpace(ownerUserId: string, spaceId: string) {
    const space = await this.getSpace(ownerUserId, spaceId);
    if (!space) throw new SpaceNotFoundError();
    return space;
  }
  async updateSpace(ownerUserId: string, spaceId: string, patch: { name?: string; description?: string }) {
    const space = await this.requireSpace(ownerUserId, spaceId);
    Object.assign(space, patch, { updatedAt: this.now() });
    return space;
  }
  async deleteSpace(ownerUserId: string, spaceId: string) {
    await this.requireSpace(ownerUserId, spaceId);
    this.spaces.delete(spaceId);
    for (const page of [...this.pages.values()]) {
      if (page.spaceId === spaceId) this.pages.delete(page.id);
    }
  }
  async createPage(ownerUserId: string, spaceId: string, input: { title: string; content: string; editorState?: Record<string, unknown> | null; parentId?: string | null; sourceThreadId?: string | null; by?: string }) {
    await this.requireSpace(ownerUserId, spaceId);
    if (input.parentId) {
      const parent = this.pages.get(input.parentId);
      if (!parent || parent.spaceId !== spaceId) throw new PageNotFoundError();
    }
    const page: PageRecord = {
      id: this.id("page"),
      spaceId,
      parentId: input.parentId ?? null,
      title: input.title,
      content: input.content,
      editorState: input.editorState ?? null,
      revision: 1,
      sourceThreadId: input.sourceThreadId ?? null,
      createdBy: input.by ?? null,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.pages.set(page.id, page);
    return page;
  }
  async listPages(ownerUserId: string, spaceId: string) {
    await this.requireSpace(ownerUserId, spaceId);
    return [...this.pages.values()].filter((p) => p.spaceId === spaceId);
  }
  async getPage(ownerUserId: string, spaceId: string, pageId: string) {
    if (!(await this.getSpace(ownerUserId, spaceId))) return null;
    const page = this.pages.get(pageId);
    return page && page.spaceId === spaceId ? page : null;
  }
  async updatePage(ownerUserId: string, spaceId: string, pageId: string, patch: { title?: string; content?: string; editorState?: Record<string, unknown> | null; parentId?: string | null; expectedRevision: number }) {
    await this.requireSpace(ownerUserId, spaceId);
    const page = this.pages.get(pageId);
    if (!page || page.spaceId !== spaceId) throw new PageNotFoundError();
    if (page.revision !== patch.expectedRevision) {
      throw new PageConflictError("This page changed. Reload the latest revision before saving your draft.");
    }
    if (patch.parentId !== undefined && patch.parentId !== null) {
      // Cycle check: the new parent must not be the page or one of its descendants.
      let cursor: string | null = patch.parentId;
      while (cursor) {
        if (cursor === pageId) throw new SpaceRefusedError("A page cannot be moved into itself or a descendant.");
        cursor = this.pages.get(cursor)?.parentId ?? null;
      }
    }
    Object.assign(page, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
      revision: page.revision + 1,
      updatedAt: this.now(),
    });
    return page;
  }
  async deletePage(ownerUserId: string, spaceId: string, pageId: string) {
    await this.requireSpace(ownerUserId, spaceId);
    const page = this.pages.get(pageId);
    if (!page || page.spaceId !== spaceId) throw new PageNotFoundError();
    for (const candidate of this.pages.values()) {
      if (candidate.parentId === pageId) candidate.parentId = page.parentId;
    }
    this.pages.delete(pageId);
  }
  async grantSpace(ownerUserId: string, spaceId: string, agentId: string) {
    await this.requireSpace(ownerUserId, spaceId);
    this.grants.add(`${spaceId}:${agentId}`);
  }
  async revokeSpace(ownerUserId: string, spaceId: string, agentId: string) {
    await this.requireSpace(ownerUserId, spaceId);
    this.grants.delete(`${spaceId}:${agentId}`);
  }
  async grantedAgentIds(ownerUserId: string, spaceId: string) {
    await this.requireSpace(ownerUserId, spaceId);
    return [...this.grants].filter((g) => g.startsWith(`${spaceId}:`)).map((g) => g.split(":")[1]);
  }
  async canAccess(agentId: string, spaceId: string) {
    return this.grants.has(`${spaceId}:${agentId}`);
  }
  async accessibleSpaces(ownerUserId: string, agentId: string) {
    return [...this.spaces.values()].filter(
      (s) => s.ownerUserId === ownerUserId && this.grants.has(`${s.id}:${agentId}`),
    );
  }
  async threadFor(pageId: string, agentId: string) {
    return this.threads.get(`${pageId}:${agentId}`) ?? null;
  }
  async bindThread(pageId: string, agentId: string, threadId: string) {
    this.threads.set(`${pageId}:${agentId}`, threadId);
  }
  async pageForThread(threadId: string) {
    for (const [key, value] of this.threads) {
      if (value === threadId) {
        const [pageId, agentId] = key.split(":");
        const page = this.pages.get(pageId);
        const space = page ? this.spaces.get(page.spaceId) : undefined;
        if (page && space) return { page, space, agentId };
      }
    }
    return null;
  }
  async createReviewed(ownerUserId: string, spaceId: string, input: { threadId: string; toolCallId: string; title: string; content: string; by?: string }) {
    await this.requireSpace(ownerUserId, spaceId);
    const key = `${input.threadId}:${input.toolCallId}`;
    const receipt = this.reviews.get(key);
    if (receipt) {
      if (receipt.spaceId !== spaceId) throw new PageConflictError("This review was already saved to another Space.");
      if (receipt.title !== input.title || receipt.content !== input.content) {
        throw new PageConflictError("This review was already saved with a different draft. Start a new review for the changed draft.");
      }
      return { page: this.pages.get(receipt.pageId) ?? null, alreadySaved: true };
    }
    const page = await this.createPage(ownerUserId, spaceId, {
      title: input.title,
      content: input.content,
      sourceThreadId: input.threadId,
      by: input.by,
    });
    this.reviews.set(key, { pageId: page.id, spaceId, title: input.title, content: input.content });
    return { page, alreadySaved: false };
  }
}

function routesAs(store: SpaceStore, actor: typeof OWNER) {
  const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (context, next) => {
    context.set("actor", actor);
    await next();
  };
  let minted = 0;
  const threadIdentity: ThreadIdentity = {
    mint: () => `thread-${++minted}`,
    owns: () => true,
  };
  return createSpaceRoutes(store, requireUser, { threadIdentity });
}

async function call(routes: ReturnType<typeof createSpaceRoutes>, method: string, path: string, body?: unknown) {
  const response = await routes.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, never> };
}

describe("space and page routes", () => {
  test("space CRUD is owner-scoped", async () => {
    const store = new FakeSpaceStore();
    const mine = routesAs(store, OWNER);
    const theirs = routesAs(store, OTHER);
    const created = await call(mine, "POST", "/", { name: "Research", description: "Notes" });
    expect(created.status).toBe(201);
    const spaceId = (created.json.space as { id: string }).id;
    expect((await call(theirs, "GET", "/")).json).toEqual({ spaces: [] });
    expect((await call(theirs, "GET", `/${spaceId}/pages`)).status).toBe(404);
    const patched = await call(mine, "PATCH", `/${spaceId}`, { name: "Research 2" });
    expect((patched.json.space as { name: string }).name).toBe("Research 2");
    expect((await call(mine, "DELETE", `/${spaceId}`)).status).toBe(200);
    expect((await call(mine, "GET", "/")).json).toEqual({ spaces: [] });
  });

  test("a stale save is a 409 with the conflict sentence; the fresh save lands", async () => {
    const store = new FakeSpaceStore();
    const routes = routesAs(store, OWNER);
    const spaceId = ((await call(routes, "POST", "/", { name: "S" })).json.space as { id: string }).id;
    const page = (await call(routes, "POST", `/${spaceId}/pages`, { title: "Plan", content: "v1" })).json.page as { id: string; revision: number };
    expect(page.revision).toBe(1);
    const stale = await call(routes, "PATCH", `/${spaceId}/pages/${page.id}`, { content: "v2", expectedRevision: 7 });
    expect(stale.status).toBe(409);
    expect((stale.json as { error: string }).error).toContain("This page changed. Reload the latest revision");
    const saved = await call(routes, "PATCH", `/${spaceId}/pages/${page.id}`, { content: "v2", expectedRevision: 1 });
    expect(saved.status).toBe(200);
    expect((saved.json.page as { revision: number }).revision).toBe(2);
  });

  test("deleting a page re-parents its children; a cycle move is refused", async () => {
    const store = new FakeSpaceStore();
    const routes = routesAs(store, OWNER);
    const spaceId = ((await call(routes, "POST", "/", { name: "S" })).json.space as { id: string }).id;
    const parent = (await call(routes, "POST", `/${spaceId}/pages`, { title: "P", content: "" })).json.page as { id: string };
    const child = (await call(routes, "POST", `/${spaceId}/pages`, { title: "C", content: "", parentId: parent.id })).json.page as { id: string; revision: number };
    const cycle = await call(routes, "PATCH", `/${spaceId}/pages/${parent.id}`, { parentId: child.id, expectedRevision: 1 });
    expect(cycle.status).toBe(400);
    await call(routes, "DELETE", `/${spaceId}/pages/${parent.id}`);
    const after = (await call(routes, "GET", `/${spaceId}/pages/${child.id}`)).json.page as { parentId: string | null };
    expect(after.parentId).toBeNull();
  });
});

describe("grants, conversations and the Bot tools", () => {
  async function setup() {
    const store = new FakeSpaceStore();
    const routes = routesAs(store, OWNER);
    const spaceId = ((await call(routes, "POST", "/", { name: "Research" })).json.space as { id: string }).id;
    const page = (await call(routes, "POST", `/${spaceId}/pages`, { title: "Brief", content: "Facts." })).json.page as { id: string; revision: number };
    const tools = spaceTools({ store, ownerUserId: OWNER.id, agentId: "bot-1" });
    const run = async (name: string, args: unknown) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`no tool ${name}`);
      return tool.execute(args);
    };
    return { store, routes, spaceId, page, run };
  }

  test("without a grant the Bot sees nothing and the conversation refuses", async () => {
    const { routes, spaceId, page, run } = await setup();
    expect(await run("list_spaces", {})).toBe("[]");
    expect(await run("read_page", { page_id: page.id })).toContain("Refused.");
    const conversation = await call(routes, "POST", `/${spaceId}/pages/${page.id}/conversation`, { agentId: "bot-1" });
    expect(conversation.status).toBe(400);
  });

  test("with a grant: tools read and write, the conversation binds once, revocation bites", async () => {
    const { store, routes, spaceId, page, run } = await setup();
    await call(routes, "POST", `/${spaceId}/grants`, { agentId: "bot-1" });
    const spaces = JSON.parse(await run("list_spaces", {})) as { id: string }[];
    expect(spaces.map((s) => s.id)).toEqual([spaceId]);
    const read = JSON.parse(await run("read_page", { page_id: page.id })) as { content: string; revision: number };
    expect(read.content).toBe("Facts.");
    const stale = await run("update_page", { page_id: page.id, expected_revision: 9, content: "New." });
    expect(stale).toContain("Refused. This page changed.");
    const saved = JSON.parse(await run("update_page", { page_id: page.id, expected_revision: 1, content: "New." })) as { revision: number };
    expect(saved.revision).toBe(2);

    const first = await call(routes, "POST", `/${spaceId}/pages/${page.id}/conversation`, { agentId: "bot-1" });
    const second = await call(routes, "POST", `/${spaceId}/pages/${page.id}/conversation`, { agentId: "bot-1" });
    expect((first.json as { threadId: string }).threadId).toBe((second.json as { threadId: string }).threadId);

    await call(routes, "DELETE", `/${spaceId}/grants/bot-1`);
    expect(await store.canAccess("bot-1", spaceId)).toBe(false);
    expect(await run("read_page", { page_id: page.id })).toContain("Refused.");
  });

  test("create_page in the one granted space, and the page context text", async () => {
    const { routes, spaceId, page, run } = await setup();
    await call(routes, "POST", `/${spaceId}/grants`, { agentId: "bot-1" });
    const created = JSON.parse(await run("create_page", { title: "From chat", content: "Body." })) as { spaceId: string; revision: number };
    expect(created.spaceId).toBe(spaceId);
    expect(created.revision).toBe(1);
    const space = await routes.request("/", { method: "GET" });
    expect(space.status).toBe(200);
    const text = pageContextText(
      { ...page, content: "Facts.", spaceId } as PageRecord,
      { id: spaceId, name: "Research", description: "", createdAt: new Date(), updatedAt: new Date() },
    );
    expect(text).toContain('Space "Research"');
    expect(text).toContain("untrusted document content");
    expect(text).toContain("Facts.");
  });
});

describe("reviewed pages", () => {
  test("an approved draft lands once; a changed draft under the same review conflicts", async () => {
    const store = new FakeSpaceStore();
    const routes = routesAs(store, OWNER);
    const spaceId = ((await call(routes, "POST", "/", { name: "Research" })).json.space as { id: string }).id;
    const page = (await call(routes, "POST", `/${spaceId}/pages`, { title: "Host", content: "" })).json.page as { id: string };
    await call(routes, "POST", `/${spaceId}/grants`, { agentId: "bot-1" });
    const conversation = await call(routes, "POST", `/${spaceId}/pages/${page.id}/conversation`, { agentId: "bot-1" });
    const threadId = (conversation.json as { threadId: string }).threadId;

    const draft = { threadId, toolCallId: "call-1", title: "Draft", content: "Approved text." };
    const first = await call(routes, "POST", `/${spaceId}/pages/reviewed`, draft);
    expect(first.status).toBe(201);
    const savedId = (first.json.page as { id: string }).id;
    const retry = await call(routes, "POST", `/${spaceId}/pages/reviewed`, draft);
    expect(retry.status).toBe(200);
    expect((retry.json as { alreadySaved: boolean }).alreadySaved).toBe(true);
    expect((retry.json.page as { id: string }).id).toBe(savedId);
    const changed = await call(routes, "POST", `/${spaceId}/pages/reviewed`, { ...draft, content: "Different." });
    expect(changed.status).toBe(409);
    const list = (await call(routes, "GET", `/${spaceId}/pages`)).json.pages as unknown[];
    expect(list.length).toBe(2); // host page + the one reviewed page, no duplicate
  });
});
