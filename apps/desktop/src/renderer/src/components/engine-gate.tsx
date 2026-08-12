import { Card, CardContent, CardHeader, CardTitle } from "@clanker-forge/ui/components/card";
import type { ReactNode } from "react";
import { EngineOfflineMessage } from "../features/engine-offline";
import { type EnginePhase, enginePhase, useEngineStatus } from "../features/use-engine-status";

function EngineOfflineCard({ title, phase }: { title: string; phase: Exclude<EnginePhase, "up"> }) {
  return (
    <div className="p-6">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
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

export function EngineGate({ title, children }: { title: string; children: ReactNode }) {
  const { status } = useEngineStatus();
  const phase = enginePhase(status);
  if (phase === "up") return <>{children}</>;
  return <EngineOfflineCard title={title} phase={phase} />;
}
