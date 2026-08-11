import { Button } from "@clanker-forge/ui/components/button";
import { useEffect, useState } from "react";
import type { DaemonStatusResult, EngineStatus } from "../../shared/ipc";

const engineStatusLabel: Record<EngineStatus, string> = {
  starting: "Starting",
  running: "Running",
  adopted: "Adopted",
  stopped: "Stopped",
  failed: "Failed",
};

function DaemonStatusView({ result }: { result: DaemonStatusResult }): React.JSX.Element {
  if (!result.ok) {
    return <p className="text-sm text-destructive">Could not reach the daemon: {result.message}</p>;
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

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-10">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">clanker-forge</h1>
        <span className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
          Engine: {engineStatus === "unknown" ? "…" : engineStatusLabel[engineStatus]}
        </span>
      </header>

      <section className="flex flex-col gap-4 rounded-xl border border-border p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Daemon status</h2>
          <Button size="sm" variant="outline" onClick={refresh}>
            Refresh
          </Button>
        </div>
        {daemon ? (
          <DaemonStatusView result={daemon} />
        ) : (
          <p className="text-sm text-muted-foreground">Refresh to query the daemon through the IPC seam.</p>
        )}
      </section>
    </main>
  );
}

export default App;
