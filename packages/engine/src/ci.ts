export type CheckState = "passing" | "failing" | "pending";

export interface CheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly startedAtMillis: number;
}

const failingConclusions = new Set(["failure", "timed_out", "cancelled", "startup_failure"]);

const latestPerName = (runs: ReadonlyArray<CheckRun>) => [
  ...runs
    .reduce((byName, run) => {
      const seen = byName.get(run.name);
      if (!seen || run.startedAtMillis >= seen.startedAtMillis) byName.set(run.name, run);
      return byName;
    }, new Map<string, CheckRun>())
    .values(),
];

export const checkState = (runs: ReadonlyArray<CheckRun>): CheckState => {
  const latest = latestPerName(runs);
  if (latest.some((run) => run.conclusion !== null && failingConclusions.has(run.conclusion)))
    return "failing";
  if (latest.some((run) => run.status !== "completed")) return "pending";
  return "passing";
};
