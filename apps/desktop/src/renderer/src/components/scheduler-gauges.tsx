import type { SchedulerStats } from "@clanker-forge/contracts";
import { Badge } from "@clanker-forge/ui/components/badge";
import { Progress } from "@clanker-forge/ui/components/progress";
import { Switch } from "@clanker-forge/ui/components/switch";
import { useBoard } from "../features/use-board";
import { useScheduling } from "../features/use-scheduling";

const percent = (used: number, limit: number) => (limit > 0 ? Math.min(100, (used / limit) * 100) : 0);

function Gauge({ label, used, limit }: { label: string; used: number; limit: number }) {
  return (
    <div className="flex min-w-36 flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          {used} / {limit}
        </span>
      </div>
      <Progress value={percent(used, limit)} className="w-full" />
    </div>
  );
}

function WorkspaceLoad({ scheduler }: { scheduler: SchedulerStats }) {
  const busy = scheduler.perWorkspace.filter((load) => load.inFlight > 0);
  if (busy.length === 0) {
    return <span className="text-xs text-muted-foreground">No workspace load</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {busy.map((load) => (
        <Badge key={load.name} variant="secondary">
          {load.name} · {load.inFlight}
        </Badge>
      ))}
    </div>
  );
}

function PauseControl({ scheduler }: { scheduler: SchedulerStats }) {
  const { result, setScheduling } = useScheduling();
  const paused = scheduler.scheduling === "paused";

  return (
    <div className="flex items-center gap-3">
      <Badge variant={paused ? "destructive" : "default"}>{paused ? "Paused" : "Running"}</Badge>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Scheduling</span>
        <Switch
          aria-label={paused ? "Resume scheduling" : "Pause scheduling"}
          checked={!paused}
          disabled={result.waiting}
          onCheckedChange={(on) => setScheduling(on ? "running" : "paused")}
        />
      </div>
    </div>
  );
}

export function SchedulerGauges() {
  const result = useBoard();
  if (result._tag !== "Success" || result.board.scheduler === null) return null;

  const scheduler = result.board.scheduler;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 border-b px-6 py-2.5">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <Gauge label="In flight" used={scheduler.globalInFlight} limit={scheduler.globalLimit} />
        <Gauge label="Daily budget" used={scheduler.dailyBudgetUsed} limit={scheduler.dailyBudgetLimit} />
        <WorkspaceLoad scheduler={scheduler} />
      </div>
      <PauseControl scheduler={scheduler} />
    </div>
  );
}
