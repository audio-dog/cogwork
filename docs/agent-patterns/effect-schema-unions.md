# Effect schema-backed unions

Use this reference when defining a domain type with variants, branching on one, or decoding one at a boundary. It covers discriminated unions, branded identifiers, and decoder placement — not the error channel (see the control-flow pattern) and not test doubles.

## Model

A union you branch on is schema-backed and discriminated, and the schema generates the fold.

- Every `_tag === "..."` if-chain, `switch`, or string-keyed handler table is a missing `.match`. The generated fold is exhaustive: adding a variant becomes a compile error at every fold instead of a silent fallthrough.
- A fold over a schema-backed union that crosses the RPC wire uses the generated `match`. A single-variant test uses the generated `guards`.
- Decode once at the boundary into the domain type. Downstream code reads typed fields; it never re-decodes a `Schema.Unknown` payload or re-guards a discriminant.
- Branded identifiers cross every service seam. A port that takes `(workspace: string, workItem: string)` compiles when the arguments are swapped; one that takes `(WorkspaceId, WorkItemId)` does not.
- Openness is a scoped decision. A deliberately uncurated payload keeps its rest-record, but its discriminant still gets a real union so the folds stay checked.

## Choose the smallest operator

| Need | Prefer |
| --- | --- |
| Define a union discriminated by `_tag` | `Schema.TaggedUnion({ ... })` |
| Add `match`/`guards` to a union with another discriminant | `Schema.toTaggedUnion("type")` |
| Fold over every variant | the generated `Union.match` |
| Fold over some variants with one shared fallback | the generated `Union.matchOrElse` |
| Test for one variant or a subset | the generated `guards.X` / `isAnyOf` |
| In-process union with constructors, never encoded | `Data.taggedEnum` with `$match` |
| Brand a scalar identifier | `makeBrand` in `packages/contracts/src/base-schemas.ts` |
| Decode external data | a module-scope `Schema.decodeUnknownEffect(X)` (or `...Option` for best-effort) |

## A union you branch on generates its own fold

`DaemonEvent` and `ClassifiedItem` are the house exemplars: `Schema.TaggedUnion` definitions in `packages/contracts/src/daemon-event.ts`, folded exhaustively with the generated `.match`.

```ts
export const applyDaemonEvent = (board: Board, event: DaemonEvent): Board =>
  DaemonEvent.match(event, {
    SeedEnd: () => board,
    RunActivity: () => board,
    ItemChanged: ({ workspace, item }) => ({
      ...board,
      items: new Map(board.items).set(itemKey(workspace, item.id), { workspace, item }),
    }),
    // ... every variant is required; a new variant fails to compile here ...
  });
```

The anti-pattern is a union declared as plain `Schema.Union` of tagged structs, which generates no `.match` and forces if-chains:

```ts
// Avoid: non-exhaustive by construction — a new scope silently ranks 3
const scopeRank = (scope: SettingScope) => {
  if (scope._tag === "SettingsProfile") return 0;
  if (scope._tag === "RuntimeHost") return 1;
  if (scope._tag === "WorkspaceInput") return 2;
  return 3;
};
```

Declare the union with `Schema.TaggedUnion`, or pipe an existing `Schema.Union` of tagged structs through `Schema.toTaggedUnion("_tag")`, and the chain becomes a checked fold. The same applies to single-variant tests: `event._tag === "SeedEnd"` in a stream filter is the generated `DaemonEvent.guards.SeedEnd` written by hand.

## Harness event dispatches use generated partial folds

The CLI watch renderer and the desktop run preview and transcript once folded the harness event stream with a `Record<string, Handler>` or `Map` keyed by `event.type` and a silent `?? ignore` fallback:

```ts
// Avoid: nothing checks these keys against anything
const handlers: Record<string, Handler> = {
  RUN_STARTED: runStarted,
  TOOL_CALL_START: toolStart,
  // ...
};
const handle = handlers[event.type] ?? ignore;
```

All three dispatches now use `AgUiEvent.matchOrElse`, where the fallback is one deliberate, visible choice instead of a lookup miss:

```ts
AgUiEvent.matchOrElse(
  event,
  {
    TEXT_MESSAGE_CONTENT: ({ delta }) => appendText(state, delta),
    TOOL_CALL_START: ({ toolCallId, toolCallName }) => openTool(state, toolCallId, toolCallName),
  },
  () => state,
);
```

For the harness event specifically, the openness is a recorded decision (`packages/contracts/CONTEXT.md`, "Harness event": unnamed keys ride along instead of being dropped at decode). The pattern respects it: each named variant keeps its rest-record for unnamed keys, a catch-all variant carries every type the union does not name, and only the discriminant becomes closed.

## In-process unions still get constructors and matching

A union that never crosses a wire does not need a schema, but it still needs exhaustiveness. `classify`'s `Outcome` uses `Data.taggedEnum` for constructors and `$match` with no schema overhead:

```ts
declare const emptyOutcome: unique symbol;
type EmptyOutcome = { readonly [emptyOutcome]?: never };

type Outcome = Data.TaggedEnum<{
  Eligible: { readonly stage: LifecycleStage };
  Claimed: { readonly claim: Claim };
  Blocked: EmptyOutcome;
  NeedsHuman: { readonly reason: NeedsHumanReason };
  ReadyToMerge: { readonly pr: ObservedPr };
  Drop: EmptyOutcome;
}>;
const Outcome = Data.taggedEnum<Outcome>();
```

Choose deliberately: `Schema.TaggedUnion` when the value is ever encoded, persisted, or decoded; `Data.taggedEnum` when it lives and dies in one process.

## Brands cross the seam

`packages/contracts/src/base-schemas.ts` owns the house brand shape — `TrimmedNonEmptyString.pipe(Schema.brand("X"))` via `makeBrand`, exported as a `const`/`type` pair. The gap is enforcement: the run ledger brands `RunId` and `SessionId` but takes `(workspace: string, workItem: string, branch: string)` on the same service, so a swapped-argument call compiles.

Ports take branded ids. The conversion from raw strings happens once, at the boundary that reads them (decode) or mints them (`Schema.decodeSync` on a constant, or the schema's `make`), never inside business logic.

## Decode once, at the boundary

Hoist the decoder to module scope next to the schema, and decode into the full domain type in one pass. This is already house style at the harness boundary:

```ts
const decodeEvent = Schema.decodeUnknownOption(AgUiEvent);
```

The anti-pattern is decoding a field lazily, per access, after the value already crossed the boundary:

```ts
// Avoid: a second decode of a field the first decode left as Schema.Unknown
export const agUiSessionId = (event: AgUiEvent) => {
  if (event.type !== "CUSTOM" || !event.name?.endsWith(".session-id")) return null;
  return Option.getOrNull(Option.map(decodeSessionIdValue(event.value), (v) => v.sessionId));
};
```

Helpers like this exist only because the variant's payload is typed `Schema.Unknown`. Give the variant a real payload schema and the helper becomes a field read. When the decoded value feeds a workflow, convert the `SchemaError` to the domain error at the same boundary (see the validation-boundaries section of the control-flow pattern).

Choose the decoder by what failure means there: `decodeUnknownEffect` when failure is a typed error the workflow handles, `decodeUnknownOption` when best-effort is correct (a foreign stream chunk that may not be an event), `decodeUnknownSync` only for compile-time constants.

A struct built from fields at run time can be empty. An empty `Schema.Struct({})` decodes any value except `null` and `undefined` (strings and numbers too), and parse options such as `onExcessProperty` do not apply to it; its JSON Schema is `anyOf: [object, array]`. When "no fields" must mean "no keys", use `Schema.Record(Schema.String, Schema.Never)`, the form Effect itself uses for `Tool.EmptyParams`: it refuses every key and emits `{ type: "object", additionalProperties: false }` (#953).

## Cogwork conventions

- A union branched on more than once is `Schema.TaggedUnion` (or `Schema.Union` piped through `Schema.toTaggedUnion`) when it is ever encoded, `Data.taggedEnum` when it is process-local. String-literal `kind` unions and bare `_tag` object types are not declared by hand.
- Folds use the generated `match`; partial folds use `matchOrElse` with one explicit fallback. `Record<string, Handler>` dispatch keyed by a raw discriminant is retired on touch.
- Single-variant tests use the generated `guards`, not `_tag ===`.
- New identifiers are brands from `makeBrand` in contracts; service and port signatures take the branded type, never `string`.
- Decoders are module-scope constants next to their schema. A payload field a consumer reads gets a schema in its variant; `Schema.Unknown` is reserved for payloads nobody reads.
- Deliberate openness (the harness event's rest-record) is kept, and stays documented in the owning `CONTEXT.md`; it never justifies an undiscriminated `type: Schema.String`.

## Sources

- `.repos/effect/packages/effect/src/Schema.ts`: `TaggedUnion` and its generated `cases`/`guards`/`isAnyOf`/`match`/`matchOrElse`; `toTaggedUnion` for non-`_tag` discriminants; `brand`; the `decodeUnknown*` family; `TaggedError`.
- `.repos/effect/packages/effect/src/Data.ts`: `taggedEnum` with `$match`/`$is`.
- `.repos/effect/ai-docs/src/01_effect/02_schema/10_schema-basics.ts`: hoisted module-scope decoders and `Schema.Class` domain models; `index.md`'s rule — parse untrusted data with `Schema`, never predicates.
- `.agents/skills/effect-ts/references/guide-schema.md`.
- `packages/contracts/src/daemon-event.ts` and `packages/contracts/src/board.ts`: the in-repo `TaggedUnion` + `.match` exemplars.
- `packages/contracts/src/ag-ui.ts`, `apps/cli/src/watch.ts`, `apps/desktop/src/renderer/src/features/run-activity.ts`, and `apps/desktop/src/renderer/src/features/run-transcript.ts`: the flat event schema and its generated partial folds.
- `packages/engine/src/session-choice.ts`: the process-local `Data.taggedEnum` exemplar.
- `packages/engine/src/run-ledger.ts`: `workspace`/`workItem` are branded now; `branch` is the remaining raw-string parameter on the same signatures.
- `packages/contracts/CONTEXT.md` ("Harness event"): the recorded openness decision the pattern preserves.
- `.repos/t3code/packages/contracts/src/baseSchemas.ts`: `makeEntityId` (the same brand factory) and `ForwardCompatibleArray`, a principled decode-time forward-compatibility transform.
- `.repos/opencode/packages/opencode/src/session/schema.ts`: prefix-checked brands (note: opencode pins an older beta; `Schema.TaggedErrorClass` there is `Schema.TaggedError` on the pinned 4.1 release — verify names against `.repos/effect` before copying).
