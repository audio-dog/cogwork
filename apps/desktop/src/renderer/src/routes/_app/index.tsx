import { createFileRoute } from "@tanstack/react-router";
import { EngineGate } from "../../components/engine-gate";
import { Feed, FeedSkeleton } from "../../components/feed";

function HomePage() {
  return (
    <EngineGate.Provider>
      <EngineGate.Live>
        <Feed />
      </EngineGate.Live>
      <EngineGate.Connecting>
        <FeedSkeleton />
      </EngineGate.Connecting>
      <EngineGate.Off />
      <EngineGate.Broken />
    </EngineGate.Provider>
  );
}

export const Route = createFileRoute("/_app/")({
  component: HomePage,
});
