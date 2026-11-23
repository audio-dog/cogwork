export type CheckState = "passing" | "failing" | "pending";

export interface CheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly startedAtMillis: number;
  readonly completedAtMillis?: number;
  readonly detailsUrl?: string | null;
  readonly outputTitle?: string | null;
  readonly outputSummary?: string | null;
  readonly actionsJobId?: number | null;
}

const failingConclusions = new Set(["failure", "timed_out", "cancelled", "startup_failure"]);

export const isFailing = (run: CheckRun) => run.conclusion !== null && failingConclusions.has(run.conclusion);

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
  if (latest.some(isFailing)) return "failing";
  if (latest.some((run) => run.status !== "completed")) return "pending";
  return "passing";
};

export const latestFailingCheckAtMillis = (runs: ReadonlyArray<CheckRun>) =>
  latestPerName(runs)
    .filter(isFailing)
    .reduce((latest, run) => Math.max(latest, run.completedAtMillis ?? 0), 0) || null;
