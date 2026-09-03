# Effect schema-union folds

Date: 2026-09-02. Primary source: pinned Effect `4.0.0-rc.112` in `.repos/effect`.

## Finding

For a schema-backed discriminated union, use the utilities generated on the schema value:

- `Union.match(value, cases)` for an exhaustive fold;
- `Union.matchOrElse(value, cases, fallback)` for a deliberate partial fold;
- `Union.guards.Variant(value)` for one variant;
- `Union.isAnyOf(["A", "B"])(value)` for a subset.

`Schema.TaggedUnion({ ... })` builds an `_tag` union with those utilities. An existing
`Schema.Union` can gain the same utilities for `_tag` or another discriminant through
`.pipe(Schema.toTaggedUnion("type"))`.

## Why `match` is exhaustive

`TaggedUnion.match` types `cases` as a mapped object with one required handler per case. The generic
`toTaggedUnion` form likewise maps every flattened member discriminant to a required handler. Adding
a variant therefore makes an existing `match` call fail type-checking until its handler is added.
`matchOrElse` intentionally makes handlers optional and types the fallback separately.

Sources:

- `.repos/effect/packages/effect/src/Schema.ts:6219-6274` — generated utility types for converted
  unions; `match` requires all cases and `matchOrElse` permits a checked subset.
- `.repos/effect/packages/effect/src/Schema.ts:6403-6440` — the direct `TaggedUnion` interface exposes
  the same exhaustive and partial folds.
- `.repos/effect/packages/effect/src/Schema.ts:6443-6468` — public API documentation and exhaustive
  `Shape.match` example.
- `.repos/effect/packages/effect/test/schema/Schema.test.ts:9277-9315` — pinned-version tests exercise
  both direct and piped forms of `match` and `matchOrElse`.

## Why `guards` fit single-variant checks

Each generated `guards.X` is a type predicate for exactly variant `X`. It is stronger than a raw
discriminant comparison: construction uses `Schema.is(Schema.toType(member))`, so the predicate
checks the complete decoded variant shape. Pinned tests accept valid variants and reject values with
the correct tag but an invalid payload.

Sources:

- `.repos/effect/packages/effect/src/Schema.ts:6231-6234` and `6417-6420` — `isAnyOf` and per-case
  guard signatures narrow the union.
- `.repos/effect/packages/effect/src/Schema.ts:6342-6354` — each guard is generated from its member
  schema.
- `.repos/effect/packages/effect/test/schema/Schema.test.ts:9263-9275` — official tests use
  `isAnyOf` and `guards.A`/`B`/`C`, including invalid-payload cases.

## How the utilities reach consumers

The utilities are properties of the schema constant, not separate exports. `toTaggedUnion` augments
an existing union with `Object.assign`; `TaggedUnion` constructs its cases, calls
`toTaggedUnion("_tag")`, then returns a schema carrying `cases`, `guards`, `isAnyOf`, `match`, and
`matchOrElse`. Exporting that schema constant therefore exports its generated utilities unchanged.

Effect exposes the constructor APIs through both `import * as Schema from "effect/Schema"` and the
root `import { Schema } from "effect"` namespace.

Sources:

- `.repos/effect/packages/effect/src/Schema.ts:6288-6330` — `toTaggedUnion` API and augmentation.
- `.repos/effect/packages/effect/src/Schema.ts:6470-6482` — direct construction and attachment.
- `.repos/effect/packages/effect/package.json:29-56` — root and `./*` package exports.
- `.repos/effect/packages/effect/src/index.ts:519-522` — root `Schema` namespace export.

## Cogwork evidence and lint consequence

The local schema-union pattern already states this policy: wire-crossing unions use generated
`match`; single-variant tests use generated `guards`; partial folds use `matchOrElse`
(`docs/agent-patterns/effect-schema-unions.md:5-26,28-57,133-140`).

`DaemonEvent` is the clearest exemplar. Its exported `Schema.TaggedUnion` defines the wire model
(`packages/contracts/src/daemon-event.ts:18-24,45-66`); board folding uses exhaustive
`DaemonEvent.match`, while stream boundary detection passes `DaemonEvent.guards.SeedEnd` directly
(`packages/contracts/src/board.ts:56-60,87-123`). Non-`_tag` AG-UI events show the conversion form
with `Schema.toTaggedUnion("type")` and expose the generated utilities on the public schema value
(`packages/contracts/src/ag-ui.ts:55-84,109-123,159-170`).

For #443, a rule should target hand-written discriminant branching only when the referenced schema
value actually has generated fold utilities. Plain unions without `TaggedUnion` or `toTaggedUnion`
have no generated fold and must remain outside the rule.
