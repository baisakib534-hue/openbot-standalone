import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  IconArrowLeft,
  IconCode,
  IconDeviceFloppy,
  IconDownload,
  IconEye,
  IconFilePlus,
  IconMessage,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { usePageAutosave } from "@/lib/spaces/autosave";
import {
  createPage,
  deletePage,
  pagesQueryOptions,
  spaceKeys,
  type Page,
  type Space,
} from "@/lib/spaces/api";
import { cn } from "@/lib/utils";
import { PageChat } from "./page-chat";
import { PageEditor } from "./page-editor";

/**
 * One page: title, the visual editor (or the markdown source), autosave with its conflict
 * state, the page's place in the tree, and the page's own conversation docked on the right.
 * Chrome follows the app's own pages; every colour is a theme token, so both skins hold.
 */

const STATUS_TEXT: Record<string, string> = {
  saved: "All changes saved",
  dirty: "Unsaved changes",
  saving: "Saving…",
  error: "Could not save",
  conflict: "Changes need review",
};

export function PageView({ space, page }: { space: Space; page: Page }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: pages } = useQuery({
    ...pagesQueryOptions(space.id),
    refetchInterval: 3000,
  });
  const current = (pages ?? []).find((candidate) => candidate.id === page.id) ?? page;
  const { draft, setDraft, status, error, flush } = usePageAutosave(current);
  const [sourceMode, setSourceMode] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [editorKey, setEditorKey] = useState(0);

  const siblings = (pages ?? []).filter(
    (candidate) => candidate.id !== page.id && candidate.parentId !== page.id,
  );
  const children = (pages ?? []).filter((candidate) => candidate.parentId === page.id);

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: spaceKeys.pages(space.id) });

  const newSubpage = useMutation({
    mutationFn: () =>
      createPage(space.id, { title: "Untitled subpage", content: "", parentId: page.id }),
    onSuccess: async (created) => {
      await refresh();
      await navigate({
        to: "/spaces/$spaceId/pages/$pageId",
        params: { spaceId: space.id, pageId: created.id },
      });
    },
  });
  const remove = useMutation({
    mutationFn: () => deletePage(space.id, page.id),
    onSuccess: async () => {
      await refresh();
      await navigate({ to: "/spaces/$spaceId", params: { spaceId: space.id } });
    },
  });

  const useLatest = () => {
    // Drop the draft for the server's version: remount the editor on the polled page and let
    // the autosave hook start again from it.
    setEditorKey((key) => key + 1);
    window.location.reload();
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/spaces/$spaceId"
            params={{ spaceId: space.id }}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <IconArrowLeft size={16} /> {space.name}
          </Link>
          <span
            className={cn(
              "text-sm",
              status === "conflict" || status === "error"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
            role="status"
          >
            {STATUS_TEXT[status]}
          </span>
          <span className="ml-auto flex flex-wrap gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => void flush()}>
              <IconDeviceFloppy size={16} /> Save now
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSourceMode((value) => !value)}
            >
              {sourceMode ? <IconEye size={16} /> : <IconCode size={16} />}
              {sourceMode ? "Visual editor" : "Markdown source"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => newSubpage.mutate()}>
              <IconFilePlus size={16} /> New subpage
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                const blob = new Blob([draft.content], { type: "text/markdown" });
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = `${draft.title || "page"}.md`;
                anchor.click();
                URL.revokeObjectURL(url);
              }}
            >
              <IconDownload size={16} /> Download
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setChatOpen((value) => !value)}
            >
              <IconMessage size={16} /> Discuss
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive"
              onClick={() => {
                if (window.confirm(`Delete “${current.title}”? Subpages move up a level.`)) {
                  remove.mutate();
                }
              }}
            >
              <IconTrash size={16} /> Delete
            </Button>
          </span>
        </div>

        {error ? (
          <div className="flex items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <span>{error}</span>
            {status === "conflict" ? (
              <Button type="button" size="sm" variant="outline" onClick={useLatest}>
                Load the latest version
              </Button>
            ) : null}
          </div>
        ) : null}

        <Input
          aria-label="Page title"
          value={draft.title}
          maxLength={160}
          onChange={(event) => setDraft({ title: event.target.value })}
          className="border-none text-xl font-semibold shadow-none focus-visible:ring-0"
        />

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Parent
          <Select
            value={draft.parentId ?? "root"}
            onValueChange={(value) =>
              setDraft({ parentId: value === "root" ? null : (value as string) })
            }
          >
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="root">Space root</SelectItem>
              {siblings.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {current.sourceThreadId ? (
            <span className="text-xs">Saved from a conversation</span>
          ) : null}
        </label>

        {sourceMode ? (
          <Textarea
            aria-label="Page Markdown"
            value={draft.content}
            maxLength={100_000}
            onChange={(event) =>
              setDraft({ content: event.target.value, editorState: null })
            }
            className="min-h-96 flex-1 font-mono text-sm"
          />
        ) : (
          <PageEditor
            key={`${page.id}:${editorKey}`}
            initialMarkdown={current.content}
            onChange={(markdown, editorState) => setDraft({ content: markdown, editorState })}
          />
        )}

        {children.length > 0 ? (
          <section className="border-t border-border pt-3">
            <h2 className="text-sm font-medium text-foreground">Subpages</h2>
            <ul className="mt-2 space-y-1">
              {children.map((child) => (
                <li key={child.id}>
                  <Link
                    to="/spaces/$spaceId/pages/$pageId"
                    params={{ spaceId: space.id, pageId: child.id }}
                    className="text-sm text-primary underline-offset-2 hover:underline"
                  >
                    {child.title}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      {chatOpen ? (
        <aside className="flex w-96 shrink-0 flex-col border-l border-border bg-background p-3">
          <PageChat space={space} page={current} />
        </aside>
      ) : null}
    </div>
  );
}
