import {
  type HarnessName,
  type HarnessReadiness,
  HarnessState,
  ParkReason,
  type WorkflowPark,
  type WorkflowRecord,
} from "@cogwork/contracts";
import { providerLabel } from "./provider-presentation";

export interface HarnessAlert {
  readonly harness: HarnessName;
  readonly key: string;
  readonly title: string;
  readonly signIn: string | null;
  readonly detail: string | null;
  readonly parked: number;
}

interface HarnessProblem {
  readonly problem: string;
  readonly signIn: string | null;
  readonly detail: string | null;
}

const harnessProblem = (label: string) =>
  HarnessState.match({
    Ready: () => null,
    NotSignedIn: ({ signIn }): HarnessProblem => ({
      problem: "is not signed in",
      signIn: signIn?.command ?? null,
      detail: signIn ? null : `Sign in with the ${label} CLI.`,
    }),
    NotInstalled: ({ diagnostic }): HarnessProblem => ({
      problem: "is not installed",
      signIn: null,
      detail: diagnostic,
    }),
    UnsupportedVersion: ({ requirement }): HarnessProblem => ({
      problem: "version is not supported",
      signIn: null,
      detail: requirement ? `Needs ${requirement}` : null,
    }),
    Unavailable: () => null,
    Unknown: () => null,
  });

const enabledOperations = (workflows: ReadonlyArray<WorkflowRecord>, defaultHarness: HarnessName | null) =>
  workflows.flatMap(({ id, enabled, publishedCopy }) =>
    enabled && publishedCopy
      ? publishedCopy.operations.map((operation) => ({
          workflow: id,
          operation: operation.id,
          harness: operation.model.harness ?? defaultHarness,
        }))
      : [],
  );

export const harnessAlerts = ({
  workflows,
  defaultHarness,
  readiness,
  parks,
  dismissed,
}: {
  readonly workflows: ReadonlyArray<WorkflowRecord>;
  readonly defaultHarness: HarnessName | null;
  readonly readiness: HarnessReadiness | null;
  readonly parks: ReadonlyArray<WorkflowPark>;
  readonly dismissed: Readonly<Record<string, string>>;
}) => {
  const operations = enabledOperations(workflows, defaultHarness);
  return (readiness?.harnesses ?? []).flatMap(({ harness, enabled, state }) => {
    const label = providerLabel(harness);
    const problem = harnessProblem(label)(state);
    if (!problem) return [];
    const used = operations.filter((operation) => operation.harness === harness);
    const key = JSON.stringify([state._tag, problem.signIn, problem.detail]);
    const isSilent = !enabled || used.length === 0 || dismissed[harness] === key;
    if (isSilent) return [];
    const parked = parks.filter(
      (park) =>
        ParkReason.guards.MissingOperation(park.reason) &&
        used.some(({ workflow, operation }) => workflow === park.workflow && operation === park.operation),
    ).length;
    const alert: HarnessAlert = {
      harness,
      key,
      title: `${label} ${problem.problem}`,
      signIn: problem.signIn,
      detail: problem.detail,
      parked,
    };
    return [alert];
  });
};
