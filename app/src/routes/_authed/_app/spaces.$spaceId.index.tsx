import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { SpaceLibrary } from "@/components/spaces/space-library";
import { spacesQueryOptions } from "@/lib/spaces/api";

export const Route = createFileRoute("/_authed/_app/spaces/$spaceId/")({
  component: SpacePage,
});

function SpacePage() {
  const { spaceId } = Route.useParams();
  const { data: spaces } = useQuery(spacesQueryOptions());
  const space = (spaces ?? []).find((candidate) => candidate.id === spaceId);
  return (
    <PageShell
      title={space?.name ?? "Space"}
      description={space?.description}
      backButton={{ label: "Spaces", linkProps: { to: "/spaces" } }}
      width="wide"
    >
      {space ? (
        <SpaceLibrary space={space} />
      ) : (
        <p className="text-sm text-muted-foreground">Loading this Space…</p>
      )}
    </PageShell>
  );
}
