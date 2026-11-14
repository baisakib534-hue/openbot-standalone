import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { recordAuditEvent, type AuditStore } from "../audit";
import type { Database } from "../db/client";
import {
  pageReviews,
  pages,
  pageThreads,
  spaceGrants,
  spaces,
} from "../db/schema";

/**
 * Spaces and pages, ported from OpenDots onto this deployment's own conventions.
 *
 * WHAT CAME ACROSS. A space holds a tree of markdown pages; a save names the revision it was
 * written against and a mismatch is a conflict rather than an overwrite; deleting a page
 * re-parents its children instead of orphaning them; a Bot reaches a space only through an
 * explicit grant; one conversation per (page, Bot) pair; a reviewed draft lands once, under a
 * receipt. WHAT CHANGED ON THE WAY. OpenDots is single-owner with no per-row owner, so its
 * scoping is the space id alone; here every method is owner-scoped like the routines store —
 * a space id in somebody else's hands reads as no space at all — and pages carry the editor's
 * JSON beside the markdown (the markdown stays the source of truth).
 */

export type SpaceRecord = {
  id: string;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PageRecord = {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  content: string;
  editorState: Record<string, unknown> | null;
  revision: number;
  sourceThreadId: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export class SpaceNotFoundError extends Error {
  constructor() {
    super("That space was not found.");
    this.name = "SpaceNotFoundError";
  }
}

export class PageNotFoundError extends Error {
  constructor() {
    super("Page not found in this Space.");
    this.name = "PageNotFoundError";
  }
}

/** A save written against a revision the page has since moved past. Mapped to 409 by the routes. */
export class PageConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageConflictError";
  }
}

export class SpaceRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpaceRefusedError";
  }
}

export type SpaceStore = {
  createSpace(
    ownerUserId: string,
    input: { name: string; description: string },
  ): Promise<SpaceRecord>;
  listSpaces(ownerUserId: string): Promise<SpaceRecord[]>;
  getSpace(ownerUserId: string, spaceId: string): Promise<SpaceRecord | null>;
  updateSpace(
    ownerUserId: string,
    spaceId: string,
    patch: { name?: string; description?: string },
  ): Promise<SpaceRecord>;
  deleteSpace(ownerUserId: string, spaceId: string): Promise<void>;

  createPage(
    ownerUserId: string,
    spaceId: string,
    input: {
      title: string;
      content: string;
      editorState?: Record<string, unknown> | null;
      parentId?: string | null;
      sourceThreadId?: string | null;
      by?: string;
    },
  ): Promise<PageRecord>;
  listPages(ownerUserId: string, spaceId: string): Promise<PageRecord[]>;
  getPage(
    ownerUserId: string,
    spaceId: string,
    pageId: string,
  ): Promise<PageRecord | null>;
  updatePage(
    ownerUserId: string,
    spaceId: string,
    pageId: string,
    patch: {
      title?: string;
      content?: string;
      editorState?: Record<string, unknown> | null;
      parentId?: string | null;
      expectedRevision: number;
    },
  ): Promise<PageRecord>;
  deletePage(
    ownerUserId: string,
    spaceId: string,
    pageId: string,
  ): Promise<void>;

  grantSpace(
    ownerUserId: string,
    spaceId: string,
    agentId: string,
    by: string,
  ): Promise<void>;
  revokeSpace(
    ownerUserId: string,
    spaceId: string,
    agentId: string,
    by: string,
  ): Promise<void>;
  grantedAgentIds(ownerUserId: string, spaceId: string): Promise<string[]>;
  /** May this Bot work in this space at all — the check every Bot-facing path stands behind. */
  canAccess(agentId: string, spaceId: string): Promise<boolean>;
  /** The spaces this person owns that this Bot has been granted — what its tools may see. */
  accessibleSpaces(
    ownerUserId: string,
    agentId: string,
  ): Promise<SpaceRecord[]>;

  threadFor(pageId: string, agentId: string): Promise<string | null>;
  bindThread(pageId: string, agentId: string, threadId: string): Promise<void>;
  /** The page a thread is bound to, with its space — a run's way back to its document. */
  pageForThread(
    threadId: string,
  ): Promise<{ page: PageRecord; space: SpaceRecord; agentId: string } | null>;

  /**
   * Land a reviewed draft, once. A retry under the same (threadId, toolCallId) answers with the
   * page the first approval wrote (`alreadySaved`); a changed draft, or the same review aimed
   * at another space, is a conflict.
   */
  createReviewed(
    ownerUserId: string,
    spaceId: string,
    input: {
      threadId: string;
      toolCallId: string;
      title: string;
      content: string;
      by?: string;
    },
  ): Promise<{ page: PageRecord | null; alreadySaved: boolean }>;
};

type SpaceRow = typeof spaces.$inferSelect;
type PageRow = typeof pages.$inferSelect;

function toSpace(row: SpaceRow): SpaceRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPage(row: PageRow): PageRecord {
  return {
    id: row.id,
    spaceId: row.spaceId,
    parentId: row.parentId,
    title: row.title,
    content: row.content,
    editorState: row.editorState ?? null,
    revision: row.revision,
    sourceThreadId: row.sourceThreadId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createSpaceStore(
  database: Database,
  auditStore?: AuditStore,
): SpaceStore {
  async function requireSpace(
    ownerUserId: string,
    spaceId: string,
  ): Promise<SpaceRow> {
    const [row] = await database
      .select()
      .from(spaces)
      .where(and(eq(spaces.id, spaceId), eq(spaces.ownerUserId, ownerUserId)))
      .limit(1);
    if (!row) throw new SpaceNotFoundError();
    return row;
  }

  async function requirePage(
    spaceId: string,
    pageId: string,
  ): Promise<PageRow> {
    const [row] = await database
      .select()
      .from(pages)
      .where(and(eq(pages.id, pageId), eq(pages.spaceId, spaceId)))
      .limit(1);
    if (!row) throw new PageNotFoundError();
    return row;
  }

  /** Walking up from a proposed parent: it must exist in this space and contain no cycle. */
  async function requireValidParent(
    spaceId: string,
    pageId: string | null,
    parentId: string | null,
  ): Promise<void> {
    if (parentId === null) return;
    const seen = new Set<string>();
    let cursor: string | null = parentId;
    while (cursor !== null) {
      if (pageId !== null && cursor === pageId) {
        throw new SpaceRefusedError(
          "A page cannot be moved into itself or a descendant.",
        );
      }
      if (seen.has(cursor)) {
        throw new SpaceRefusedError("That page's ancestry already loops.");
      }
      seen.add(cursor);
      const [row] = await database
        .select({ parentId: pages.parentId, spaceId: pages.spaceId })
        .from(pages)
        .where(eq(pages.id, cursor))
        .limit(1);
      if (!row || row.spaceId !== spaceId) throw new PageNotFoundError();
      cursor = row.parentId;
    }
  }

  async function insertPage(
    spaceId: string,
    input: {
      title: string;
      content: string;
      editorState?: Record<string, unknown> | null;
      parentId?: string | null;
      sourceThreadId?: string | null;
      by?: string;
    },
  ): Promise<PageRecord> {
    const id = randomUUID();
    const [row] = await database
      .insert(pages)
      .values({
        id,
        spaceId,
        parentId: input.parentId ?? null,
        title: input.title,
        content: input.content,
        editorState: input.editorState ?? null,
        revision: 1,
        sourceThreadId: input.sourceThreadId ?? null,
        createdBy: input.by ?? null,
      })
      .returning();
    return toPage(row);
  }

  return {
    async createSpace(ownerUserId, input) {
      const [row] = await database
        .insert(spaces)
        .values({
          id: randomUUID(),
          ownerUserId,
          name: input.name,
          description: input.description,
        })
        .returning();
      return toSpace(row);
    },

    async listSpaces(ownerUserId) {
      const rows = await database
        .select()
        .from(spaces)
        .where(eq(spaces.ownerUserId, ownerUserId))
        .orderBy(asc(spaces.createdAt), asc(spaces.id));
      return rows.map(toSpace);
    },

    async getSpace(ownerUserId, spaceId) {
      const [row] = await database
        .select()
        .from(spaces)
        .where(
          and(eq(spaces.id, spaceId), eq(spaces.ownerUserId, ownerUserId)),
        )
        .limit(1);
      return row ? toSpace(row) : null;
    },

    async updateSpace(ownerUserId, spaceId, patch) {
      await requireSpace(ownerUserId, spaceId);
      const [row] = await database
        .update(spaces)
        .set({ ...patch, updatedAt: new Date() })
        .where(
          and(eq(spaces.id, spaceId), eq(spaces.ownerUserId, ownerUserId)),
        )
        .returning();
      return toSpace(row);
    },

    async deleteSpace(ownerUserId, spaceId) {
      await requireSpace(ownerUserId, spaceId);
      await database
        .delete(spaces)
        .where(
          and(eq(spaces.id, spaceId), eq(spaces.ownerUserId, ownerUserId)),
        );
    },

    async createPage(ownerUserId, spaceId, input) {
      await requireSpace(ownerUserId, spaceId);
      await requireValidParent(spaceId, null, input.parentId ?? null);
      return insertPage(spaceId, input);
    },

    async listPages(ownerUserId, spaceId) {
      await requireSpace(ownerUserId, spaceId);
      const rows = await database
        .select()
        .from(pages)
        .where(eq(pages.spaceId, spaceId))
        .orderBy(asc(pages.createdAt), asc(pages.id));
      return rows.map(toPage);
    },

    async getPage(ownerUserId, spaceId, pageId) {
      const space = await this.getSpace(ownerUserId, spaceId);
      if (!space) return null;
      const [row] = await database
        .select()
        .from(pages)
        .where(and(eq(pages.id, pageId), eq(pages.spaceId, spaceId)))
        .limit(1);
      return row ? toPage(row) : null;
    },

    async updatePage(ownerUserId, spaceId, pageId, patch) {
      await requireSpace(ownerUserId, spaceId);
      const page = await requirePage(spaceId, pageId);
      if (page.revision !== patch.expectedRevision) {
        throw new PageConflictError(
          "This page changed. Reload the latest revision before saving your draft.",
        );
      }
      if (patch.parentId !== undefined) {
        await requireValidParent(spaceId, pageId, patch.parentId);
      }
      const [row] = await database
        .update(pages)
        .set({
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.content !== undefined ? { content: patch.content } : {}),
          ...(patch.editorState !== undefined
            ? { editorState: patch.editorState }
            : {}),
          ...(patch.parentId !== undefined
            ? { parentId: patch.parentId }
            : {}),
          revision: page.revision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(pages.id, pageId),
            eq(pages.spaceId, spaceId),
            eq(pages.revision, patch.expectedRevision),
          ),
        )
        .returning();
      if (!row) {
        // Lost a race between the read and the write: the same conflict, honestly reported.
        throw new PageConflictError(
          "This page changed. Reload the latest revision before saving your draft.",
        );
      }
      return toPage(row);
    },

    async deletePage(ownerUserId, spaceId, pageId) {
      await requireSpace(ownerUserId, spaceId);
      const page = await requirePage(spaceId, pageId);
      await database.transaction(async (transaction) => {
        // Children move up to the deleted page's parent, as OpenDots does — a delete must not
        // orphan a subtree. Their revision moves too: their place in the tree changed.
        await transaction
          .update(pages)
          .set({ parentId: page.parentId, updatedAt: new Date() })
          .where(eq(pages.parentId, pageId));
        await transaction
          .delete(pages)
          .where(and(eq(pages.id, pageId), eq(pages.spaceId, spaceId)));
      });
    },

    async grantSpace(ownerUserId, spaceId, agentId, by) {
      await requireSpace(ownerUserId, spaceId);
      await database
        .insert(spaceGrants)
        .values({ spaceId, agentId, grantedBy: by })
        .onConflictDoUpdate({
          target: [spaceGrants.spaceId, spaceGrants.agentId],
          set: { grantedBy: by, updatedAt: new Date() },
        });
      if (auditStore) {
        await recordAuditEvent(auditStore, {
          eventType: "configuration.changed",
          targetType: "space",
          targetId: spaceId,
          payload: { actor: by, change: "space_granted", space: spaceId, bot: agentId },
        });
      }
    },

    async revokeSpace(ownerUserId, spaceId, agentId, by) {
      await requireSpace(ownerUserId, spaceId);
      await database
        .delete(spaceGrants)
        .where(
          and(
            eq(spaceGrants.spaceId, spaceId),
            eq(spaceGrants.agentId, agentId),
          ),
        );
      if (auditStore) {
        await recordAuditEvent(auditStore, {
          eventType: "configuration.changed",
          targetType: "space",
          targetId: spaceId,
          payload: { actor: by, change: "space_revoked", space: spaceId, bot: agentId },
        });
      }
    },

    async grantedAgentIds(ownerUserId, spaceId) {
      await requireSpace(ownerUserId, spaceId);
      const rows = await database
        .select({ agentId: spaceGrants.agentId })
        .from(spaceGrants)
        .where(eq(spaceGrants.spaceId, spaceId));
      return rows.map((row) => row.agentId);
    },

    async canAccess(agentId, spaceId) {
      const [row] = await database
        .select({ spaceId: spaceGrants.spaceId })
        .from(spaceGrants)
        .where(
          and(
            eq(spaceGrants.spaceId, spaceId),
            eq(spaceGrants.agentId, agentId),
          ),
        )
        .limit(1);
      return row !== undefined;
    },

    async accessibleSpaces(ownerUserId, agentId) {
      const rows = await database
        .select({ space: spaces })
        .from(spaces)
        .innerJoin(spaceGrants, eq(spaceGrants.spaceId, spaces.id))
        .where(
          and(
            eq(spaces.ownerUserId, ownerUserId),
            eq(spaceGrants.agentId, agentId),
          ),
        )
        .orderBy(asc(spaces.createdAt), asc(spaces.id));
      return rows.map((row) => toSpace(row.space));
    },

    async threadFor(pageId, agentId) {
      const [row] = await database
        .select({ threadId: pageThreads.threadId })
        .from(pageThreads)
        .where(
          and(
            eq(pageThreads.pageId, pageId),
            eq(pageThreads.agentId, agentId),
          ),
        )
        .limit(1);
      return row?.threadId ?? null;
    },

    async bindThread(pageId, agentId, threadId) {
      await database
        .insert(pageThreads)
        .values({ pageId, agentId, threadId })
        .onConflictDoNothing();
    },

    async pageForThread(threadId) {
      const [row] = await database
        .select({ page: pages, space: spaces, agentId: pageThreads.agentId })
        .from(pageThreads)
        .innerJoin(pages, eq(pages.id, pageThreads.pageId))
        .innerJoin(spaces, eq(spaces.id, pages.spaceId))
        .where(eq(pageThreads.threadId, threadId))
        .limit(1);
      return row
        ? { page: toPage(row.page), space: toSpace(row.space), agentId: row.agentId }
        : null;
    },

    async createReviewed(ownerUserId, spaceId, input) {
      await requireSpace(ownerUserId, spaceId);
      return database.transaction(async (transaction) => {
        const [receipt] = await transaction
          .select()
          .from(pageReviews)
          .where(
            and(
              eq(pageReviews.threadId, input.threadId),
              eq(pageReviews.toolCallId, input.toolCallId),
            ),
          )
          .limit(1);
        if (receipt) {
          if (receipt.spaceId !== spaceId) {
            throw new PageConflictError(
              "This review was already saved to another Space.",
            );
          }
          if (
            receipt.draft.title !== input.title ||
            receipt.draft.content !== input.content
          ) {
            throw new PageConflictError(
              "This review was already saved with a different draft. Start a new review for the changed draft.",
            );
          }
          const [page] = await transaction
            .select()
            .from(pages)
            .where(eq(pages.id, receipt.pageId))
            .limit(1);
          return { page: page ? toPage(page) : null, alreadySaved: true };
        }
        const [row] = await transaction
          .insert(pages)
          .values({
            id: randomUUID(),
            spaceId,
            parentId: null,
            title: input.title,
            content: input.content,
            editorState: null,
            revision: 1,
            sourceThreadId: input.threadId,
            createdBy: input.by ?? null,
          })
          .returning();
        const page = toPage(row);
        await transaction.insert(pageReviews).values({
          threadId: input.threadId,
          toolCallId: input.toolCallId,
          pageId: page.id,
          spaceId,
          draft: { title: input.title, content: input.content },
        });
        return { page, alreadySaved: false };
      });
    },
  };
}
