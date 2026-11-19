# Effect error design

Use this reference when defining a new error type or extending a port's failure vocabulary. It
covers choosing the base class and the fields. For branching on errors already defined, see
`effect-control-flow.md`; for decoding at boundaries, see `effect-schema-unions.md`.

## Model

Errors are contracts. Choose the base class by who consumes the error, not by where the file lives.

- `Schema.TaggedError<Self>()(tag, fields)` — schema-validated fields; participates in contracts and
  RPC tooling. The default for a port's published failures.
- `Data.TaggedError(tag)<Fields>` — a plain class, no schema. For errors that are intentionally
  local to one module.
- On the pinned 4.1 release the API is `Schema.TaggedError`. `Schema.TaggedErrorClass` is the older-beta
  name — opencode, t3code, and the local `guide-error-handling.md` still carry it — and it does not
  exist at `effect@4.1.4`.

## Choose the base class

| The error | Prefer |
| --- | --- |
| Is part of a port's contract: appears in an exported service signature, crosses RPC/IPC, or reports a decoded external response | `Schema.TaggedError` |
| Is a private classification wrapper, unwrapped before it escapes the module | `Data.TaggedError` |
| Is boot-only with an unstructured message, never serialized | `Data.TaggedError` |

The port contract, schema-backed:

```ts
export class IssueTrackerError extends Schema.TaggedError<IssueTrackerError>()("IssueTrackerError", {
  reason: PollPauseReason,
  message: Schema.String,
  retryable: Schema.optional(Schema.Boolean),
  retryAfterMillis: Schema.optional(Schema.Finite),
  connectionId: Schema.optional(ConnectionId),
}) {}
```

The private wrapper, plain and unexported — it carries a retry classification across a retry loop
and is unwrapped before the effect escapes:

```ts
class LinearRequestFailure extends Data.TaggedError("LinearRequestFailure")<{
  readonly error: IssueTrackerError;
  readonly retryable: boolean;
}> {}

// ...later, before the caller sees it:
Effect.mapError((failure) => failure.error);
```

Do not promote a wrapper like this to `Schema.TaggedError`: it never crosses a boundary, and the
schema would document a contract nobody consumes.

## One error class per port

A port owns one error class. Distinct failure kinds are `reason` string literals inside it, so
callers branch on data:

```ts
export class HarnessError extends Schema.TaggedError<HarnessError>()("HarnessError", {
  reason: Schema.Literals([
    "unknown-harness",
    "missing-harness",
    "incompatible-harness",
    "credential",
    "stale-selection",
    "policy",
    "workspace",
    "sandbox",
    "launch",
    "turn",
  ]),
  retryable: Schema.Boolean,
  message: Schema.String,
}) {}
```

A union in an `Effect<A, E>` signature composes different ports' errors — never variants of the same
port:

```ts
const settle = <A, R>(
  attempt: Effect.Effect<A, PrepareError | HarnessError, R>,
  complete: (acc: A) => Effect.Effect<void, IssueTrackerError | RunLedgerError>,
) =>
```

Avoid splitting one port into a class-per-kind union. It multiplies `catchTag` arms at every
consumer and turns each new failure kind into a signature change across the codebase:

```ts
// Avoid: one port, many classes
Effect.Effect<Session, HarnessLaunchError | HarnessTurnError | HarnessPolicyError>
// Prefer: one class, reason literals
Effect.Effect<Session, HarnessError>
```

Consumers preserve a port's producer-owned retry decision. The Issue tracker refines its optional
field into the permanent-refusal decision:

```ts
const retryableOf = (error: PrepareError | HarnessError | IssueTrackerError) => {
  if (error._tag === "IssueTrackerError") return !issueTrackerErrorIsPermanent(error);
  return error.retryable;
};
```

```ts
if (error.retryable) return null;
if (error.reason === "credential") return hostFailure("credential", error.message);
if (error.reason === "policy") {
  return policyRefusal(`Harness ${resolved.stage.harness}`, error.message);
}
return hostFailure("harness", error.message);
```

## The retryable field

Add `retryable` only where callers make a retry decision, and keep its meaning aligned with the
contracts vocabulary: `packages/contracts/GLOSSARY.md` defines a permanent refusal as
`IssueTrackerError.retryable === false`, and the port refines it further:

```ts
// A rate limit and a rejected credential are both `retryable: false` — do not retry *now* — yet both
// clear on their own. Only an `unavailable` refusal is the tracker declining the write itself.
export const issueTrackerErrorIsPermanent = (error: IssueTrackerError) =>
  error.retryable === false && error.reason === "unavailable";
```

Every executor `PrepareError` member carries `retryable`. Its producer must choose the value, so a
new member cannot silently inherit a consumer-side default. A timed-out Git operation is retryable;
a diverged worktree is not (engine ADR 0002). Outside that union, add the field only when a caller
makes a retry decision and the producer knows the answer better than the consumer.

## No speculative channels

Per `docs/agents/technical-disposition.md`: report a normal failure as data in the success payload
(as `DaemonStatus.failures` does), and add a typed error channel when the first real failure mode
lands — never a speculative one for an operation that cannot fail today. The same goes for fields:
no `reason` enum with one value that nothing branches on, no `retryable` nobody reads.

## Naming

- The class name is the tag: `Schema.TaggedError<GitError>()("GitError", ...)`. Cogwork passes no
  namespaced identifier argument; Effect's own source namespaces
  (`Schema.TaggedError<ConnectionError>("effect/sql/SqlError/ConnectionError")(...)`) to avoid
  cross-package registry collisions, which one application does not need.
- Operational port errors end in `Error` or `Failure` (`GitError`, `HarnessError`,
  `ConnectionFailure`). A refusal or precondition on an RPC contract is named for the condition
  itself (`RunNotFound`, `ConnectionNotReady`, `OperationSettingRefused`). Private wrappers are
  named for what they classify (`LinearRequestFailure`, `GitHubAttemptError`).

## Sources

- `.repos/effect/packages/effect/src/Schema.ts`: `TaggedError`, `Literals`, `optional`.
  `Schema.TaggedErrorClass` is absent on the pinned 4.1 release — the older-beta name appears in opencode,
  t3code, and `.agents/skills/effect-ts/references/guide-error-handling.md`; see the same warning in
  `effect-schema-unions.md`.
- `.repos/effect/packages/effect/src/Data.ts`: `TaggedError` (constructor excludes `_tag` from
  args), `Error` (no `_tag`, no `catchTag` support).
- `.repos/effect/packages/effect/src/Effect.ts`: `catchTag`, `catchTags`.
- `.repos/effect/packages/effect/src/sql/SqlError.ts`: Effect's own namespaced-identifier
  convention. `.repos/effect/packages/platform/browser/src/Clipboard.ts`: a `Data.TaggedError`
  exemplar in Effect's own platform code.
- `packages/contracts/src/issue-tracker.ts`: `IssueTrackerError` and
  `issueTrackerErrorIsPermanent`. `packages/contracts/GLOSSARY.md`: the binding `retryable`
  vocabulary.
- `packages/engine/src/harness.ts`: `HarnessError` reason literals. `packages/engine/src/git.ts`:
  optional single-literal `reason`.
- `packages/engine/src/linear/client.ts`, `packages/engine/src/github/client.ts`: private
  `Data.TaggedError` wrappers, unwrapped before escaping. `packages/engine/src/control-store.ts`:
  boot-only errors.
- `packages/engine/src/workflow-run.ts`: union-of-ports signatures and `_tag` branching on plan
  execution outcomes.
- `docs/agents/technical-disposition.md`: when to add a typed error channel at all.
