# Effect control flow

Use this reference when an Effect workflow needs to branch on success or failure. It covers the typed failure channel, not resource cleanup or concurrency.

## Model

`Effect<A, E, R>` describes work that succeeds with `A`, fails with expected typed error `E`, and needs services `R`.

- Use the typed error channel for expected failures.
- Keep defects and interruption distinct. They are part of `Cause`, not ordinary `E` handling.
- Keep a failure typed until the boundary that can make a domain decision about it.

## Choose the smallest operator

| Need | Prefer |
| --- | --- |
| Recover from one known tagged error and keep success unchanged | `Effect.catchTag` |
| Produce effects for both expected failure and success | `Effect.matchEffect` |
| Produce plain values for both expected failure and success | `Effect.match` |
| Treat expected failure as data for later, non-terminal decisions | `Effect.result` |
| Inspect typed failures, defects, and interruption | `Effect.matchCauseEffect` or `Effect.exit` |

`Effect.result` is not a default replacement for error handling. It removes `E` by turning it into `Result<A, E>`; use it only when the result must survive as data beyond the immediate branch.

## Effectful terminal dispatch

When both paths immediately return effects, dispatch with `matchEffect` instead of yielding `Effect.result` and branching on `Result`.

```ts
return yield* decodeImplementResult(acc).pipe(
  Effect.matchEffect({
    onFailure: (error) =>
      applyFailure(workspace, item, runId, error.retryable, error.message, acc.handle),
    onSuccess: (result) =>
      result.outcome === "opened-pr"
        ? applyImplementSuccess(workspace, item, runId, acc)
        : applyFailure(workspace, item, runId, false, result.summary, acc.handle),
  }),
);
```

The outer match routes transport or validation failure. The success branch still makes the domain decision between `opened-pr` and `stuck`.

Use this shape when the branch settles a run, writes coordination, logs a terminal outcome, sends a response, or otherwise finishes the current workflow.

## Targeted recovery

Use `catchTag` when one expected error has a local recovery and every other error must remain visible to the caller.

```ts
const response = yield* client.execute(request).pipe(
  Effect.catchTag("HttpClientError", (error) =>
    Effect.fail(unavailable(error.message)),
  ),
);
```

This preserves the successful response and narrows only `HttpClientError`. Do not catch every error when only one case is recoverable.

## Validation boundaries

Schema decoding returns a typed `SchemaError`. Convert it to the domain error expected by the workflow at the boundary.

```ts
const decodeImplementResult = (value: unknown) =>
  Schema.decodeUnknownEffect(ImplementStageResult)(value).pipe(
    Effect.mapError((error) =>
      new HarnessError({
        reason: "turn",
        retryable: true,
        message: `invalid structured implement result: ${error.message}`,
      }),
    ),
  );
```

After this conversion, downstream code should reason about `HarnessError`, not schema internals.

## When `result` is appropriate

Use `Effect.result` when success and failure both need to become ordinary data before a later decision, such as accumulating independent outcomes or delaying settlement.

```ts
const outcome = yield* Effect.result(attempt);

return Result.isSuccess(outcome)
  ? summarize(outcome.success)
  : recordDiagnostic(outcome.failure);
```

If either branch immediately runs another Effect, prefer `matchEffect` instead.

## Full causes are exceptional

`matchEffect` sees only expected typed failures. Use `matchCauseEffect` or `Effect.exit` only when the caller must distinguish a typed failure from a defect or interruption, such as framework runtime code, process supervision, or cleanup diagnostics.

Do not flatten a cause into an ordinary error merely to make control flow convenient.

## Cogwork conventions

- Use `Effect.fn` for named, reusable effectful business operations.
- Use `Effect.gen` for multi-step orchestration.
- Use `map`, `flatMap`, and `tap` for small local composition.
- Provide services at application edges; do not hide local provisioning inside business logic.
- Use schema-backed tagged errors at protocol boundaries where the error contract matters.
- Avoid `Effect.fnUntraced` unless a concrete low-level performance reason exists.

## Sources

- `.repos/effect/packages/effect/src/Effect.ts`: `result`, `catchTag`, `matchEffect`, and `matchCauseEffect`.
- `.agents/skills/effect-ts/references/guide-effect.md`.
- `.agents/skills/effect-ts/references/guide-error-handling.md`.
- `packages/engine/src/executor.ts`: run settlement and structured-result handling.
- `packages/engine/src/github/client.ts`: typed `HttpClientError` recovery.
