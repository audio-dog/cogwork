import { createFileRoute } from "@tanstack/react-router";
import { EngineGate } from "../../components/engine-gate";
import { Feed, FeedSkeleton } from "../../components/feed";
import { HarnessAlerts } from "../../components/harness-alerts";

function HomePage() {
  return (
    <EngineGate.Provider>
      <EngineGate.Live>
        <div className="flex h-full flex-col">
          <HarnessAlerts />
          <div className="min-h-0 flex-1">
            <Feed />
          </div>
        </div>
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
