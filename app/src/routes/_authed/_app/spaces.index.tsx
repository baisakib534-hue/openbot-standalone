import { createFileRoute } from "@tanstack/react-router";
import { PageShell } from "@/components/layout/page-shell";
import { SpacesHome } from "@/components/spaces/space-library";

export const Route = createFileRoute("/_authed/_app/spaces/")({
  component: SpacesPage,
});

function SpacesPage() {
  return (
    <PageShell title="Spaces" description="Document workspaces for you and your Bots.">
      <SpacesHome />
    </PageShell>
  );
}
