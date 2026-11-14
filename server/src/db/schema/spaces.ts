import {
  type AnyPgColumn,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";
import { jsonb } from "./json";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * A person's document workspaces, ported from OpenDots' Spaces.
 *
 * A space is owned by one person, as a routine is: every read and write in the spaces store is
 * owner-scoped, so a space id in somebody else's hands reads as no space at all. Which Bots may
 * work in a space is a separate fact — {@link spaceGrants} — because owning a space and letting
 * a Bot into it are different decisions, exactly as a plugin grant is separate from owning a Bot.
 */
export const spaces = pgTable(
  "spaces",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("spaces_owner_idx").on(table.ownerUserId)],
);

/**
 * One page of a space: a markdown document in a tree.
 *
 * `content` is the markdown, and it is the source of truth — the same representation OpenDots
 * stores. `editorState` is the visual editor's own document (TipTap JSON) kept beside it so the
 * editor can reopen exactly where it left off; when the two disagree, the markdown wins and the
 * editor state is rebuilt from it. `revision` is the optimistic-concurrency counter the save
 * flow checks: a save names the revision it was written against, and a mismatch is a conflict,
 * never an overwrite. `sourceThreadId` records the conversation a page was saved from, when it
 * was saved from one.
 */
export const pages = pgTable(
  "pages",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references((): AnyPgColumn => pages.id),
    title: text("title").notNull(),
    content: text("content").notNull().default(""),
    editorState: jsonb("editor_state").$type<Record<string, unknown>>(),
    revision: integer("revision").notNull().default(1),
    sourceThreadId: text("source_thread_id"),
    createdBy: text("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("pages_space_idx").on(table.spaceId),
    index("pages_parent_idx").on(table.parentId),
  ],
);

/**
 * Which Bots may work in which space — the spaces analogue of a plugin grant row: one row per
 * (space, Bot), written and removed deliberately, with who did it recorded. Absence is the
 * refusal, as it is in `plugin_grants`.
 */
export const spaceGrants = pgTable(
  "space_grants",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.agentId] }),
    index("space_grants_agent_idx").on(table.agentId),
  ],
);

/**
 * The conversation a page and a Bot share: one thread per (page, Bot) pair, minted once and
 * reused, so "discuss this page" always continues the same conversation. The thread itself is an
 * ordinary Bot thread — this row is only the binding that lets a run find its page.
 */
export const pageThreads = pgTable(
  "page_threads",
  {
    pageId: text("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.pageId, table.agentId] }),
    uniqueIndex("page_threads_thread_idx").on(table.threadId),
  ],
);

/**
 * A reviewed page draft's receipt, keyed by the review that proposed it.
 *
 * Approving a draft in the review card and the write landing are separated by a network and a
 * human, so the approval can be retried — by the card, by a reload, by a second click. The
 * receipt makes the retry answer with the page the first approval wrote instead of writing a
 * second one, and makes a CHANGED draft under the same review an explicit conflict rather than
 * a silent second save.
 */
export const pageReviews = pgTable(
  "page_reviews",
  {
    threadId: text("thread_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    pageId: text("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    draft: jsonb("draft").$type<{ title: string; content: string }>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.threadId, table.toolCallId] })],
);
