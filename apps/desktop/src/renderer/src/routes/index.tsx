import { Card, CardContent, CardHeader, CardTitle } from "@clanker-forge/ui/components/card";
import { createFileRoute } from "@tanstack/react-router";
import { Feed } from "../components/feed";
import { EngineOfflineMessage } from "../features/engine-offline";
import { type EnginePhase, enginePhase, useEngineStatus } from "../features/use-engine-status";

function EngineOfflineCard({ phase }: { phase: Exclude<EnginePhase, "up"> }) {
  return (
    <div className="p-6">
      <Card>
        <CardHeader>
          <CardTitle>Feed</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            <EngineOfflineMessage phase={phase} />
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function HomePage() {
  const { status } = useEngineStatus();
  const phase = enginePhase(status);

  if (phase === "up") return <Feed />;
  return <EngineOfflineCard phase={phase} />;
}

export const Route = createFileRoute("/")({
  component: HomePage,
});
