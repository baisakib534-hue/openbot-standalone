import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  IconFileText,
  IconLayoutGrid,
  IconList,
  IconPlus,
  IconRobot,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { agentListQueryOptions } from "@/lib/agents/queries";
import {
  createPage,
  createSpace,
  deleteSpace,
  grantSpaceBot,
  pageExcerpt,
  pagesQueryOptions,
  revokeSpaceBot,
  spaceGrantsQueryOptions,
  spaceKeys,
  spacesQueryOptions,
  type Page,
  type Space,
} from "@/lib/spaces/api";
import { cn } from "@/lib/utils";

/**
 * One Space's library: its pages as a searchable grid or list, its subpage tree, and the Bot
 * access panel — the grant surface for the whole feature. Everything a Bot can do in a Space
 * starts with a tick in that panel; everything it cannot do is the absence of one.
 */

export function BotAccessPanel({ space }: { space: Space }) {
  const queryClient = useQueryClient();
  const { data: grants } = useQuery(spaceGrantsQueryOptions(space.id));
  const { data: bots } = useQuery(agentListQueryOptions());
  const toggle = useMutation({
    mutationFn: async ({ agentId, grant }: { agentId: string; grant: boolean }) =>
      grant ? grantSpaceBot(space.id, agentId) : revokeSpaceBot(space.id, agentId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: spaceKeys.grants(space.id) }),
  });
  if (!grants || !bots) return null;
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="flex items-center gap-2 text-sm font-medium text-card-foreground">
        <IconRobot size={16} /> Bot access
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        A Bot can list, read, create and edit this Space's pages only while it is ticked here —
        and discuss a page only with access on.
      </p>
      <ul className="mt-3 space-y-2">
        {bots.map((bot) => (
          <li key={bot.id} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={grants.includes(bot.id)}
              onCheckedChange={(checked) =>
                toggle.mutate({ agentId: bot.id, grant: checked === true })
              }
              aria-label={`Give ${bot.name} access to this Space`}
            />
            <span className="text-card-foreground">{bot.name}</span>
          </li>
        ))}
        {bots.length === 0 ? (
          <li className="text-sm text-muted-foreground">No Bots yet.</li>
        ) : null}
      </ul>
    </section>
  );
}

function PageCard({ space, page, pages }: { space: Space; page: Page; pages: Page[] }) {
  const parent = page.parentId
    ? pages.find((candidate) => candidate.id === page.parentId)
    : undefined;
  return (
    <Link
      to="/spaces/$spaceId/pages/$pageId"
      params={{ spaceId: space.id, pageId: page.id }}
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4 text-card-foreground transition-colors hover:bg-accent"
    >
      <span className="flex items-center gap-2 font-medium">
        <IconFileText size={16} className="shrink-0 text-muted-foreground" />
        <span className="truncate">{page.title}</span>
      </span>
      <span className="line-clamp-3 text-sm text-muted-foreground">
        {pageExcerpt(page.content) || "Empty page"}
      </span>
      <span className="mt-auto flex items-center gap-2 text-xs text-muted-foreground">
        <span>
          Edited{" "}
          {new Date(page.updatedAt).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })}
        </span>
        {parent ? (
          <span className="rounded bg-muted px-1.5 py-0.5">under {parent.title}</span>
        ) : null}
      </span>
    </Link>
  );
}

export function SpaceLibrary({ space }: { space: Space }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: pages } = useQuery({
    ...pagesQueryOptions(space.id),
    refetchInterval: 3000,
  });
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"recent" | "name">("recent");
  const [view, setView] = useState<"grid" | "list">("grid");

  const visible = useMemo(() => {
    const needle = query.toLowerCase();
    const filtered = (pages ?? []).filter((page) =>
      `${page.title} ${page.content}`.toLowerCase().includes(needle),
    );
    return filtered.sort((a, b) =>
      sort === "name"
        ? a.title.localeCompare(b.title)
        : b.updatedAt.localeCompare(a.updatedAt),
    );
  }, [pages, query, sort]);

  const newPage = useMutation({
    mutationFn: () => createPage(space.id, { title: "Untitled page", content: "" }),
    onSuccess: async (page) => {
      await queryClient.invalidateQueries({ queryKey: spaceKeys.pages(space.id) });
      await navigate({
        to: "/spaces/$spaceId/pages/$pageId",
        params: { spaceId: space.id, pageId: page.id },
      });
    },
  });
  const removeSpace = useMutation({
    mutationFn: () => deleteSpace(space.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: spaceKeys.spaces });
      await navigate({ to: "/spaces" });
    },
  });

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium tracking-widest text-muted-foreground">SPACE</p>
          <h1 className="text-2xl font-semibold text-foreground">{space.name}</h1>
          {space.description ? (
            <p className="mt-1 text-sm text-muted-foreground">{space.description}</p>
          ) : null}
        </div>
        <div className="flex gap-2">
          <Button type="button" onClick={() => newPage.mutate()} disabled={newPage.isPending}>
            <IconPlus size={16} /> New page
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="text-destructive"
            onClick={() => {
              if (window.confirm(`Delete the Space “${space.name}” and all its pages?`)) {
                removeSpace.mutate();
              }
            }}
          >
            <IconTrash size={16} /> Delete Space
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative flex-1 sm:max-w-xs">
          <IconSearch
            size={16}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search pages"
            placeholder="Search pages"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-8"
          />
        </label>
        <Select value={sort} onValueChange={(value) => setSort(value as "recent" | "name")}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">Recently edited</SelectItem>
            <SelectItem value="name">Name A–Z</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex overflow-hidden rounded-md border border-border">
          <Button
            type="button"
            variant={view === "grid" ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label="Grid view"
            onClick={() => setView("grid")}
          >
            <IconLayoutGrid size={16} />
          </Button>
          <Button
            type="button"
            variant={view === "list" ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label="List view"
            onClick={() => setView("list")}
          >
            <IconList size={16} />
          </Button>
        </div>
      </div>

      {pages && visible.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {query
            ? "No page matches that search."
            : "No pages yet. Create the first one — or ask a granted Bot to draft it."}
        </p>
      ) : (
        <div
          className={cn(
            view === "grid"
              ? "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
              : "flex flex-col gap-2",
          )}
        >
          {visible.map((page) => (
            <PageCard key={page.id} space={space} page={page} pages={pages ?? []} />
          ))}
        </div>
      )}

      <BotAccessPanel space={space} />
    </div>
  );
}

export function SpacesHome() {
  const queryClient = useQueryClient();
  const { data: spaces } = useQuery(spacesQueryOptions());
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () => createSpace({ name: name.trim(), description: description.trim() }),
    onSuccess: () => {
      setName("");
      setDescription("");
      void queryClient.invalidateQueries({ queryKey: spaceKeys.spaces });
    },
  });
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4">
      <header>
        <h1 className="text-2xl font-semibold text-foreground">Spaces</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Document workspaces you and your Bots write together — pages, subpages, and a
          conversation for every page.
        </p>
      </header>
      <form
        className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-card p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">New Space name</span>
          <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} />
        </label>
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Description</span>
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={500}
          />
        </label>
        <Button type="submit" disabled={!name.trim() || create.isPending}>
          <IconPlus size={16} /> Create Space
        </Button>
      </form>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(spaces ?? []).map((space) => (
          <Link
            key={space.id}
            to="/spaces/$spaceId"
            params={{ spaceId: space.id }}
            className="rounded-lg border border-border bg-card p-4 text-card-foreground transition-colors hover:bg-accent"
          >
            <p className="font-medium">{space.name}</p>
            <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
              {space.description || "No description"}
            </p>
          </Link>
        ))}
      </div>
      {spaces && spaces.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No Spaces yet. Create one above to start a library your Bots can work in.
        </p>
      ) : null}
    </div>
  );
}
