import { Alert, AlertDescription, AlertTitle } from "@clanker-forge/ui/components/alert";
import { Badge } from "@clanker-forge/ui/components/badge";
import { Button } from "@clanker-forge/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@clanker-forge/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@clanker-forge/ui/components/empty";
import { Switch } from "@clanker-forge/ui/components/switch";
import { type ComponentProps, useEffect, useState } from "react";
import type { DaemonStatusResult, EngineStatus } from "../../shared/ipc";

type BadgeVariant = ComponentProps<typeof Badge>["variant"];

const engineBadge: Record<EngineStatus | "unknown", { label: string; variant: BadgeVariant }> = {
  unknown: { label: "…", variant: "outline" },
  starting: { label: "Starting", variant: "secondary" },
  running: { label: "Running", variant: "default" },
  adopted: { label: "Adopted", variant: "default" },
  stopped: { label: "Stopped", variant: "outline" },
  failed: { label: "Failed", variant: "destructive" },
};

function DaemonStatusView({ result }: { result: DaemonStatusResult }): React.JSX.Element {
  if (!result.ok) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not reach the daemon</AlertTitle>
        <AlertDescription>{result.message}</AlertDescription>
      </Alert>
    );
  }

  const { status } = result;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
      <dt className="text-muted-foreground">Health</dt>
      <dd>{status.health}</dd>
      <dt className="text-muted-foreground">Uptime</dt>
      <dd>{Math.round(status.uptimeMillis / 1000)}s</dd>
      <dt className="text-muted-foreground">In flight</dt>
      <dd>
        {status.scheduler.globalInFlight} / {status.scheduler.globalLimit}
      </dd>
      <dt className="text-muted-foreground">Workspaces</dt>
      <dd>{status.workspaces.length}</dd>
    </dl>
  );
}

function App(): React.JSX.Element {
  const [engineStatus, setEngineStatus] = useState<EngineStatus | "unknown">("unknown");
  const [daemon, setDaemon] = useState<DaemonStatusResult | null>(null);

  useEffect(() => {
    window.clankerForge.getEngineStatus().then(setEngineStatus);
    return window.clankerForge.onEngineStatus(setEngineStatus);
  }, []);

  const refresh = (): void => {
    window.clankerForge.getDaemonStatus().then(setDaemon);
  };

  const toggleEngine = (enabled: boolean): void => {
    window.clankerForge.setEngineEnabled(enabled).then(setEngineStatus);
  };

  const engine = engineBadge[engineStatus];
  const engineOn = engineStatus === "running" || engineStatus === "starting" || engineStatus === "adopted";

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-10">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">clanker-forge</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">Engine</span>
          <Badge variant={engine.variant}>{engine.label}</Badge>
          <Switch
            aria-label="Toggle engine"
            checked={engineOn}
            disabled={engineStatus === "starting"}
            onCheckedChange={toggleEngine}
          />
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Daemon status</CardTitle>
          <CardAction>
            <Button size="sm" variant="outline" onClick={refresh}>
              Refresh
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {daemon ? (
            <DaemonStatusView result={daemon} />
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No daemon data yet</EmptyTitle>
                <EmptyDescription>Refresh to query the daemon through the IPC seam.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

export default App;
