import { type SchedulerStats, workspaceLabel } from "@cogwork/contracts";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { cn } from "@cogwork/ui/lib/utils";

import { BoardResult, useBoard } from "../features/activity-session";
import { useScheduling } from "../features/use-scheduling";

function SchedulingToggle({ scheduler }: { scheduler: SchedulerStats }) {
  const { result, setScheduling } = useScheduling();
  const paused = scheduler.scheduling === "paused";

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={result.waiting}
      className={cn("gap-2", paused && "border-amber-500/40")}
      onClick={() => setScheduling(paused ? "running" : "paused")}
    >
      <span
        className={cn(
          "size-2 rounded-full",
          paused
            ? "bg-amber-500 shadow-[0_0_8px] shadow-amber-500/60"
            : "bg-emerald-500 shadow-[0_0_8px] shadow-emerald-500/60",
        )}
      />
      {paused ? "Paused" : "Scheduling live"}
    </Button>
  );
}

function SchedulerSummary({ scheduler }: { scheduler: SchedulerStats }) {
  const busy = scheduler.perWorkspace.filter((load) => load.inFlight > 0);

  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <span>
        <span className="font-medium text-foreground">{scheduler.globalInFlight}</span> running ·{" "}
        <span className="font-medium text-foreground">{scheduler.dailyBudgetUsed}</span> /{" "}
        {scheduler.dailyBudgetLimit} runs today
      </span>
      {busy.map((load) => (
        <Badge key={load.id} variant="secondary">
          {workspaceLabel(load)} · {load.inFlight} / {load.limit}
        </Badge>
      ))}
    </div>
  );
}

export function SchedulerControls() {
  const result = useBoard();
  if (!BoardResult.$is("Success")(result) || result.board.scheduler === null) return null;

  const scheduler = result.board.scheduler;
  return (
    <div className="flex flex-wrap items-center gap-4">
      <SchedulerSummary scheduler={scheduler} />
      <SchedulingToggle scheduler={scheduler} />
    </div>
  );
}

export function PausedBanner() {
  const result = useBoard();
  if (!BoardResult.$is("Success")(result) || result.board.scheduler?.scheduling !== "paused") return null;

  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-6 py-1.5 text-center text-xs text-amber-700 dark:text-amber-300">
      Scheduling is paused. No new runs start. Runs in flight finish.
    </div>
  );
}
