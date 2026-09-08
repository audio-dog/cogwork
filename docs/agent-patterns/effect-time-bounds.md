# Effect time bounds and retries

Use this reference when an Effect crosses an external boundary: a spawned subprocess, an HTTP call, a harness stream, or a user-configured shell command. It covers deadlines and retry policy, not resource cleanup or fiber supervision.

## Model

Work that leaves the process can stall forever. Effect makes the deadline and the retry policy part of the effect's type instead of ambient hope.

- Every effect that crosses an external boundary carries a time bound.
- Retry only failures classified as transient. Classification reads tagged error fields, never message strings.
- `Schedule` owns all timing math: backoff, jitter, caps, budgets. Business code never computes delays.
- A timeout interrupts the losing effect, so the underlying operation must be abortable.

## Choose the smallest operator

| Need | Prefer |
| --- | --- |
| Fail with a typed `TimeoutError` after a deadline | `Effect.timeout` |
| Substitute a fallback effect when the deadline wins | `Effect.timeoutOrElse` |
| Deadline where absence is an ordinary outcome | `Effect.timeoutOption` |
| Fixed retry count, timing irrelevant | `Effect.retry({ times })` |
| Retry only transient failures, with backoff | `Effect.retry({ while, schedule, times })` |
| Retry against alternative provided layers | `ExecutionPlan.make` |

`ExecutionPlan` changes the provided environment between attempts. Do not reach for it when a `Schedule` on one provider is enough; see the retries guide in the effect-ts skill.

## Classify before retrying

The Linear client is the house pattern. The predicate reads a tagged error field, the schedule is a named constant next to the client, the options form combines condition, timing, and a cap, and each attempt carries its own deadline inside the retry (`withTransientAttemptDeadline`), so a hung connection fails the attempt instead of outliving the whole policy. The GitHub client carries the same discipline under different names (`withTransientRetry`, `withPaginationDeadline`, and an attempt deadline inlined in `execute`).

```ts
const isTransient = (error: IssueTrackerError) => error.reason === "unavailable";
const transientBackoff = Schedule.exponential("500 millis", 2).pipe(Schedule.jittered);

const response = yield* Effect.retry(send(repo, request), {
  while: isTransient,
  schedule: transientBackoff,
  times: 3,
});
```

Do not retry indiscriminately. An `auth` or `invalid` failure returns the same answer every attempt; retrying it hides a real defect behind latency.

## Bound every boundary

The deadline lives at the port that owns the boundary, not sprinkled at call sites. One bound in the port covers every caller.

`Effect.timeout` interrupts the work and fails with `Cause.TimeoutError`. Convert it to the port's tagged error at the boundary, the same way schema errors are converted in the control-flow pattern.

```ts
const gitCommandDeadline = "5 minutes";

const runGit = (cwd: string, args: ReadonlyArray<string>) => {
  const command = `git ${args.join(" ")}`;
  return capture(ChildProcess.make("git", [...args], { cwd })).pipe(
    Effect.mapError((cause) => fail(describe(cause))),
    Effect.timeout(gitCommandDeadline),
    Effect.catchTag("TimeoutError", () =>
      new Git.GitError({
        command,
        message: timeoutMessage(command, gitCommandDeadline),
        reason: "timeout",
      }),
    ),
    // exit-code and stderr handling follow
  );
};
```

The tagged `reason: "timeout"` matters downstream: `remoteBranchExists` recovers only when `error.reason !== "timeout"`, so a timed-out probe never reads as "branch absent".

Place the bound where it means something to the domain:

- one per subprocess invocation (`runGit`, `worktreeFs.runCommand`, sandbox `exec`)
- one per HTTP attempt, inside the retry, so the schedule gets a chance to fire on a hung connection
- one on a whole harness run (`foldStream`), where the bound is a wall-clock budget for the turn loop that `maxIterations` cannot express

A bound that fires should surface through the existing typed channel — for a harness run, a `HarnessError` with `retryable: true`, so settlement logic downstream stays unchanged.

## Make the underlying work abortable

A timeout interrupts the fiber, but interruption only helps when the boundary listens. `Effect.tryPromise` passes its callback an `AbortSignal` already wired to interruption; do not build the controller by hand.

```ts
return yield* Effect.tryPromise({
  try: (signal) => sandbox.handle.process.exec(args.command, { cwd, signal }),
  catch: (cause) => toolError("exec-failed", String(cause), cwd ?? null),
});
```

This replaces a manual `new AbortController()` plus `Effect.onInterrupt` pair.

## Compose timing in Schedule

Backoff shapes compose from small parts. Cap a growing delay with `Schedule.modifyDelay`, and express a wall-clock budget with a predicate on elapsed time instead of an attempt count.

```ts
const bounded = Schedule.exponential("100 millis", 1.7).pipe(
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(2)))),
  Schedule.jittered,
  Schedule.while((meta) => meta.elapsed < 30_000),
);
```

`Schedule.upTo({ duration })` bounds the whole policy the same way `while` on `elapsed` does. Older betas capped delays with `Schedule.either`; that combinator no longer exists in the pinned release.

Hand-written `Math.min(base * 2 ** attempt, max)` inside a retry or wait loop signals a missing `Schedule`. The exception is cross-tick cooldown state keyed by scope (the reconcile rate-limit cooldowns): that is domain data consulted between independent polls, not a retry loop, and it stays as data.

## Cogwork conventions

- Every subprocess, HTTP call, and harness stream carries a deadline at its port.
- Convert `TimeoutError` into the port's tagged error at the boundary; downstream code reasons about the domain error.
- Retry predicates read tagged error fields (`reason`, `retryable`), never message strings.
- Name the schedule as a constant next to the client (`transientBackoff`), one policy per port, so the operational behavior is visible in one place.
- Per-attempt deadlines go inside the retry; whole-operation budgets go outside it.

## Sources

- `.repos/effect/packages/effect/src/Effect.ts`: `timeout`, `timeoutOption`, `timeoutOrElse`, `retry`, and the `AbortSignal` handed to `tryPromise`.
- `.repos/effect/packages/effect/src/Schedule.ts` and `.repos/effect/cookbooks/schedule.md`: schedule composition and a problem-shape decision table.
- `.agents/skills/effect-ts/references/guide-retries.md` and `guide-schedule.md`.
- `packages/engine/src/linear/client.ts`: `isTransient`, `transientBackoff`, the retry options form, and `withTransientAttemptDeadline` — the per-attempt bound inside the retry.
- `packages/engine/src/github/client.ts`: the same discipline as `withTransientRetry` and `withPaginationDeadline`, with the attempt deadline inlined in `execute`.
- `apps/cli/src/platform.ts`: `runGit` and `worktreeFs.runCommand`, the bounded subprocess ports (`packages/engine/src/git.ts` is the port interface only).
- `.repos/t3code/apps/server/src/server.ts`: retry with a capped exponential schedule and named permanent failures.
- `.repos/opencode/packages/core/src/util/effect-flock.ts`: deadline-bounded backoff via `Schedule.while` on elapsed time (note: its `Schedule.either` cap is from an older beta).
- `.repos/opencode/packages/opencode/src/session/retry.ts`: a `Retry-After`-aware schedule built with `Schedule.fromStepWithMetadata`.
