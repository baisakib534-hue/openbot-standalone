import { queryOptions } from "@tanstack/react-query";
import { client, tryClient } from "@/lib/client";

/**
 * Spaces and pages, as the server holds them (see server/src/spaces). The markdown is the
 * source of truth; `editorState` is the visual editor's own document, kept beside it.
 */

export type Space = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
};

export type Page = {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  content: string;
  editorState: Record<string, unknown> | null;
  revision: number;
  sourceThreadId: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export const spaceKeys = {
  spaces: ["spaces"] as const,
  pages: (spaceId: string) => ["spaces", spaceId, "pages"] as const,
  page: (spaceId: string, pageId: string) =>
    ["spaces", spaceId, "pages", pageId] as const,
  grants: (spaceId: string) => ["spaces", spaceId, "grants"] as const,
};

export function spacesQueryOptions() {
  return queryOptions({
    queryKey: spaceKeys.spaces,
    queryFn: () =>
      client<Space[]>("/api/spaces", "spaces", {
        fallback: "Could not load your Spaces.",
      }),
  });
}

export function pagesQueryOptions(spaceId: string) {
  return queryOptions({
    queryKey: spaceKeys.pages(spaceId),
    queryFn: () =>
      client<Page[]>(`/api/spaces/${spaceId}/pages`, "pages", {
        fallback: "Could not load this Space's pages.",
      }),
  });
}

export function spaceGrantsQueryOptions(spaceId: string) {
  return queryOptions({
    queryKey: spaceKeys.grants(spaceId),
    queryFn: () =>
      client<string[]>(`/api/spaces/${spaceId}/grants`, "agentIds", {
        fallback: "Could not load this Space's Bot access.",
      }),
  });
}

export async function createSpace(input: {
  name: string;
  description: string;
}): Promise<Space> {
  return client<Space>("/api/spaces", "space", {
    method: "POST",
    body: input,
    fallback: "Could not create that Space.",
  });
}

export async function deleteSpace(spaceId: string): Promise<void> {
  await client(`/api/spaces/${spaceId}`, {
    method: "DELETE",
    fallback: "Could not delete that Space.",
  });
}

export async function createPage(
  spaceId: string,
  input: {
    title: string;
    content: string;
    parentId?: string | null;
    sourceThreadId?: string | null;
  },
): Promise<Page> {
  return client<Page>(`/api/spaces/${spaceId}/pages`, "page", {
    method: "POST",
    body: input,
    fallback: "Could not create that page.",
  });
}

export async function deletePage(
  spaceId: string,
  pageId: string,
): Promise<void> {
  await client(`/api/spaces/${spaceId}/pages/${pageId}`, {
    method: "DELETE",
    fallback: "Could not delete that page.",
  });
}

/**
 * One page save. The answer is a value rather than a throw, because a 409 is not a failure of
 * the request — it is the revision check doing its job, and the editor has to show it as a
 * conflict to resolve rather than as an error to retry.
 */
export type SaveOutcome =
  | { ok: true; page: Page }
  | { ok: false; conflict: boolean; error: string };

export async function savePage(
  spaceId: string,
  pageId: string,
  draft: {
    title: string;
    content: string;
    editorState: Record<string, unknown> | null;
    parentId: string | null;
    expectedRevision: number;
  },
): Promise<SaveOutcome> {
  const response = await tryClient(`/api/spaces/${spaceId}/pages/${pageId}`, {
    method: "PATCH",
    body: draft,
    fallback: "Could not save that page.",
  });
  const body = (await response.json().catch(() => null)) as {
    page?: Page;
    error?: string;
  } | null;
  if (response.ok && body?.page) return { ok: true, page: body.page };
  return {
    ok: false,
    conflict: response.status === 409,
    error: body?.error ?? "Could not save that page.",
  };
}

export async function grantSpaceBot(
  spaceId: string,
  agentId: string,
): Promise<string[]> {
  return client<string[]>(`/api/spaces/${spaceId}/grants`, "agentIds", {
    method: "POST",
    body: { agentId },
    fallback: "Could not grant that Bot access.",
  });
}

export async function revokeSpaceBot(
  spaceId: string,
  agentId: string,
): Promise<string[]> {
  return client<string[]>(
    `/api/spaces/${spaceId}/grants/${agentId}`,
    "agentIds",
    { method: "DELETE", fallback: "Could not revoke that Bot's access." },
  );
}

/** The one thread a page and a Bot share, minted by the server on first open. */
export async function pageConversation(
  spaceId: string,
  pageId: string,
  agentId: string,
): Promise<{ threadId: string }> {
  const threadId = await client<string>(
    `/api/spaces/${spaceId}/pages/${pageId}/conversation`,
    "threadId",
    { method: "POST", body: { agentId }, fallback: "Could not open that conversation." },
  );
  return { threadId };
}

/** Land a draft approved in the review card; the server's receipt makes a retry answer the same page. */
export async function saveReviewedPage(
  spaceId: string,
  input: {
    threadId: string;
    toolCallId: string;
    title: string;
    content: string;
  },
): Promise<{ page?: Page; alreadySaved?: boolean; deleted?: boolean }> {
  const response = await tryClient(`/api/spaces/${spaceId}/pages/reviewed`, {
    method: "POST",
    body: input,
    fallback: "Could not save that reviewed page.",
  });
  const body = (await response.json().catch(() => null)) as {
    page?: Page;
    alreadySaved?: boolean;
    deleted?: boolean;
    error?: string;
  } | null;
  if (!response.ok) {
    throw new Error(body?.error ?? "Could not save that reviewed page.");
  }
  return body ?? {};
}

/** A page excerpt for a library card: frontmatter, tags and markdown marks stripped, like OpenDots. */
export function pageExcerpt(content: string): string {
  const text = content
    .replace(/^---\n[\s\S]*?\n---\n?/, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[#>*`_~[\]()!-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 150 ? `${text.slice(0, 150)}…` : text;
}
