import { createFileRoute } from "@tanstack/react-router";
import { EngineGate } from "../../components/engine-gate";
import { Feed, FeedSkeleton } from "../../components/feed";

function HomePage() {
  return (
    <EngineGate skeleton={<FeedSkeleton />}>
      <Feed />
    </EngineGate>
  );
}

export const Route = createFileRoute("/_app/")({
  component: HomePage,
});
