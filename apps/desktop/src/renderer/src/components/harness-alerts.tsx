import { Alert, AlertAction, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
import { Button } from "@cogwork/ui/components/button";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { RiAlertLine, RiCloseLine, RiRefreshLine } from "@remixicon/react";
import { Link } from "@tanstack/react-router";
import { checkHarnessesAtom, harnessReadinessAtom, workflowAttentionAtom } from "../daemon/atoms";
import { BoardResult, useBoard } from "../features/activity-session";
import { plural } from "../features/format";
import { type HarnessAlert, harnessAlerts } from "../features/harness-alerts";
import { useWorkflowSession } from "../features/workflow-session";
import { useHarnessAlertStore } from "../store/harness-alerts";

function HarnessAlertCard({ alert }: { readonly alert: HarnessAlert }) {
  const check = useAtomSet(checkHarnessesAtom);
  const checking = useAtomValue(checkHarnessesAtom).waiting;
  const dismiss = useHarnessAlertStore((store) => store.dismiss);
  return (
    <Alert>
      <RiAlertLine />
      <AlertTitle>{alert.title}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        {alert.signIn && (
          <div>
            Run <code className="font-mono text-foreground">{alert.signIn}</code> in a terminal, then refresh.
          </div>
        )}
        {alert.detail && <div>{alert.detail}</div>}
        {alert.parked > 0 && (
          <Link to="/attention" search={{ layout: "board" }}>
            Review {plural(alert.parked, "parked item")}
          </Link>
        )}
        <Button size="xs" variant="outline" disabled={checking} onClick={() => check({ payload: undefined })}>
          <RiRefreshLine data-icon="inline-start" />
          {checking ? "Checking…" : "Refresh"}
        </Button>
      </AlertDescription>
      <AlertAction>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Dismiss: ${alert.title}`}
          onClick={() => dismiss(alert)}
        >
          <RiCloseLine />
        </Button>
      </AlertAction>
    </Alert>
  );
}

export function HarnessAlerts() {
  const boardResult = useBoard();
  const readinessResult = useAtomValue(harnessReadinessAtom);
  const attentionResult = useAtomValue(workflowAttentionAtom);
  const { state } = useWorkflowSession();
  const dismissed = useHarnessAlertStore((store) => store.dismissed);
  const board = BoardResult.$is("Success")(boardResult) ? boardResult.board : null;
  const queriedReadiness = readinessResult._tag === "Success" ? readinessResult.value : null;
  const alerts = harnessAlerts({
    workflows: state.workflows,
    defaultHarness: state.machine?.defaultHarness ?? null,
    readiness: board?.harnesses ?? queriedReadiness,
    parks: attentionResult._tag === "Success" ? attentionResult.value.parks : [],
    dismissed,
  });
  if (alerts.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-col gap-2 px-6 pt-6">
      {alerts.map((alert) => (
        <HarnessAlertCard key={alert.harness} alert={alert} />
      ))}
    </div>
  );
}
