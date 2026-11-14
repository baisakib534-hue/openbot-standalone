import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageView } from "@/components/spaces/page-view";
import { pagesQueryOptions, spacesQueryOptions } from "@/lib/spaces/api";

export const Route = createFileRoute("/_authed/_app/spaces/$spaceId/pages/$pageId")({
  component: PageRoute,
});

function PageRoute() {
  const { spaceId, pageId } = Route.useParams();
  const { data: spaces } = useQuery(spacesQueryOptions());
  const { data: pages } = useQuery(pagesQueryOptions(spaceId));
  const space = (spaces ?? []).find((candidate) => candidate.id === spaceId);
  const page = (pages ?? []).find((candidate) => candidate.id === pageId);
  if (!space || !page) {
    return <p className="p-4 text-sm text-muted-foreground">Loading this page…</p>;
  }
  return <PageView space={space} page={page} />;
}
