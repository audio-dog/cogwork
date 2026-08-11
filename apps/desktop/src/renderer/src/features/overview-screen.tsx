import type { DaemonStatus } from "@clanker-forge/contracts";
import { Alert, AlertDescription, AlertTitle } from "@clanker-forge/ui/components/alert";
import { Button } from "@clanker-forge/ui/components/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@clanker-forge/ui/components/card";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import type * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { daemonStatusAtom } from "../daemon/atoms";

type StatusResult = AsyncResult.AsyncResult<DaemonStatus, RpcClientError>;

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function StatusBody({ result }: { result: StatusResult }) {
  if (result._tag === "Failure") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not reach the daemon</AlertTitle>
        <AlertDescription>{Cause.pretty(result.cause)}</AlertDescription>
      </Alert>
    );
  }

  if (result._tag === "Initial") {
    return <p className="text-sm text-muted-foreground">Connecting to the daemon…</p>;
  }

  const status = result.value;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
      <StatusRow label="Health" value={status.health} />
      <StatusRow label="Uptime" value={`${Math.round(status.uptimeMillis / 1000)}s`} />
      <StatusRow
        label="In flight"
        value={`${status.scheduler.globalInFlight} / ${status.scheduler.globalLimit}`}
      />
      <StatusRow label="Workspaces" value={String(status.workspaces.length)} />
    </dl>
  );
}

export function OverviewScreen() {
  const result = useAtomValue(daemonStatusAtom);
  const refresh = useAtomRefresh(daemonStatusAtom);

  return (
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
        <StatusBody result={result} />
      </CardContent>
    </Card>
  );
}
