### 20. Interfaces

The modules the build creates, each named by its interface (`/codebase-design`): what a caller must know — types, invariants, ordering, error modes — and nothing about what is inside. Three designs were drawn for each of the three seams that carry the most weight and compared on depth, locality, and seam placement; the result is below. A ticket builds behind one of these and tests through it. Type sketches are decision-bearing and belong here; names may change, shapes may not without a spec change.

**Common rule.** Every service below is an Effect service with a `Layer`. Its external interface is the test surface: a test provides the dependencies the interface names and asserts on what the interface returns. Internal seams (a row codec, a marker codec, a socket) are private to the module and tested, where they must be, by the module's own tests, never exposed for a caller's convenience.

#### 20.1 Workflows

Two modules: the pure functions in `@cogwork/contracts`, and one deep `Workflows` service in the engine. There is no `WorkflowStore` service; the row and its codec are an internal seam of `Workflows`. The RPC handlers are one line each.

```ts
// contracts — pure; the editor, the CLI, an agent, and the daemon run the same code
type WorkflowCatalog = {                      // content only; no machine state
  entries: CatalogEntry[]                     // key, name, description, kind, requires, yields | target, actsOn,
                                              // needsWorkspace, needsFull, parameters, agentInputs
  instructionPackages: string[]
  harnesses: { name: HarnessName; models: { id: string; options: { id: string; values: (string | boolean)[] }[] }[] }[]
}
type MachineReadiness = {                     // the daemon assembles it; a client may also fold it from events
  workspaces: { id: WorkspaceId; binds: string[] }[]
  connections: { system: string; ready: boolean; reason: string | null }[]
  harnesses: { name: HarnessName; available: boolean }[]
  defaultHarness: HarnessName | null
  readyNeeds: NeedIdentity[]
}
type Decoded<A> = { _tag: "Ok"; value: A } | { _tag: "Refused"; diagnostics: Diagnostic[] }

decodeWorkflowDocument(input: unknown): Decoded<WorkflowDocument>                        // `schema`
applyWorkflowEdits(document, edits: NonEmptyArray<WorkflowEdit>): Decoded<WorkflowDocument>
validateWorkflow(document, catalog: WorkflowCatalog): Diagnostic[]                       // Malformed, Incomplete, document-only Advisory
adviseReadiness(document, catalog, machine: MachineReadiness): Diagnostic[]              // machine Advisory only
availabilityOf(entry: CatalogEntry, machine: MachineReadiness): Availability             // available | connection-needed | unavailable(reason)
```

- `applyWorkflowEdits` applies the batch in order and judges only the final document: `[RemoveOperation, RemoveTrigger]` passes where `[RemoveOperation]` alone is `unknown-reference`. One Malformed in the result refuses the whole batch and the input is unchanged. Cascades keep a single edit well-formed: `RemoveOperation` sets hand-offs that named it to null; `RemoveQuestion` and `RemoveChoice` drop the Transitions whose answers named them. A Trigger whose `start` is removed is `unknown-reference`, so the client sends both edits in one batch.
- **The edit vocabulary is flat: one tag per field or list membership.** A node is addressed by its slug; a Transition by `{ operation, when }`. Each tag becomes one `toolDefinition` for an agent and one MCP tool later, which is why there is no `ReplaceOperation` and no patch object. A whole node enters only through `Add*`, with its identity and the fields it needs to exist.

```ts
type WorkflowEdit =
  | Rename { name } | SelectWorkspaces { workspaces }
  | AddTrigger { trigger } | RemoveTrigger { trigger } | SetTriggerEntry { trigger; entry }      // resets parameters and filters
  | SetTriggerParameter { trigger; parameter; values: string[] }                                // [] removes; `many` repeats
  | SetTriggerStart { trigger; start }
  | AddTriggerFilter { trigger; filter: { entry } } | RemoveTriggerFilter { trigger; entry }  // add is idempotent
  | AddOperation { operation } | RemoveOperation { operation } | RenameOperation { operation; name }
  | SetInstruction { operation; instruction } | SetInstructionPackage { operation; package: string | null }
  | SetPermissionProfile { operation; profile } | SetRequires { operation; requires }
  | SetModel { operation; model } | SetForEach { operation; forEach: string | null }
  | AddQuestion { operation; question } | RemoveQuestion { operation; question } | SetQuestionText { operation; question; text }
  | AddChoice { operation; question; choice } | RemoveChoice { operation; question; choice } | RenameChoice { operation; question; choice; name }
  | AddTransition { operation; when } | RemoveTransition { operation; when }
  | SetTransitionActions { operation; when; actions } | SetTransitionHandOff { operation; when; handOff }
  | SetHint { operation; field; text: string | null }
```

```ts
// engine — the one deep module behind the RPCs
interface Workflows {
  create(document):                 Effect<WorkflowRecord, WorkflowRefused | ControlStoreFailure>
  edit(id, edits):                  Effect<WorkflowRecord, WorkflowNotFound | WorkflowRefused | ControlStoreFailure>
  publish(id, revision):            Effect<WorkflowRecord, WorkflowNotFound | WorkflowPublishRefused /* stale-revision | incomplete */ | ControlStoreFailure>
  switch(id, enabled):              Effect<WorkflowSwitchResult, WorkflowNotFound | WorkflowSwitchRefused /* no-published-revision */ | ControlStoreFailure>
  delete(id):                       Effect<WorkflowId, WorkflowNotFound | ControlStoreFailure>
  list:                             Effect<{ workflows: WorkflowRecord[]; unreadable: { id; message }[] }, ControlStoreFailure>
  get(id):                          Effect<WorkflowRecord, WorkflowNotFound | WorkflowUnreadable | ControlStoreFailure>
  catalog:                          Effect<{ catalog: WorkflowCatalog; machine: MachineReadiness }>
  templates:                        Effect<WorkflowTemplate[]>
  listOptions(entry, parameter, workspaces): Effect<{ value; name; listedIn: WorkspaceId[] }[], never>   // source failures as data
}
type WorkflowRecord = { id; principal; workingCopy; workingRevision; publishedCopy; publishedRevision; enabled;
  diagnostics: Diagnostic[]      // validateWorkflow(workingCopy); deterministic for a revision
  readiness:   Diagnostic[] }    // adviseReadiness as of this read; never blocks
```

- Invariants: every command runs inside the Control store write gate, so batches apply in arrival order and `workingRevision` rises by one per applied batch; `WorkflowChanged` is published inside the gate after the commit, so event order is commit order; a refused command changes no row and emits no event; `delete` also switches off; reads take no gate. A row that does not decode appears in `list.unreadable` and makes `get` fail `WorkflowUnreadable`; the others load.
- Dependencies: the Control store (local-substitutable — the in-memory SQLite layer in tests; an internal seam, no port); `DaemonEventBus` (in-process); **catalog contributions** — a `WorkflowCatalogContribution { entries; templates }` Layer per Trigger source and per action port adapter, folded by `Workflows` (two adapters from the first source, so a real seam); **`MachineReadinessSource { current: Effect<MachineReadiness> }`** — the production adapter folds Connection readiness, the Harness readiness cache and catalogs, and the Workspace registry; the test adapter is a `Ref` (two adapters, a real seam; its type lives in contracts because the editor folds a second value from the events it already receives).
- Tests: the contracts functions as tables (every §5 code once positive, once negative; batch atomicity; cascades); `Workflows` through `DaemonRpcs` over the test store (lifecycle, event order, unreadable row, a Connection flipping in the `Ref` moves a `readiness` entry and never blocks publish).

#### 20.2 Coordination

One `Coordination` module keyed by a tagged **`WorkItemRef`**. The kind is on the ref; the module alone knows which authority backs it. No type parameters, no adapter in any caller's hands.

```ts
// contracts
type WorkItemRef =
  | Issue { workspace; id: WorkItemId }                         // tracker authority (ADR 0003); Control store from the cut-over (ADR 0036)
  | PullRequest { workspace; number }                           // no linked issue → engine-minted
  | GranolaNote { connection; noteId }
  | SlackMessage { team; channel; ts } | SlackConversation { team; channel; threadTs }
  | ScheduleInstant { workflow; instantMillis }
  | FanOutChild { parent: WorkItemKey; run: RunId; position }
type WorkItemKey = string & Brand<"WorkItemKey">                 // keyOf(ref): deterministic, engine-minted
type OperationKey = { workflow: string; operation: string }     // the fixed pipeline passes ("coding", stage)
type Lineage = { root: LineageId; parent: LineageId | null; hop: number }   // required everywhere

Claim          = { by; claimedAtMillis; operation: OperationKey; lineage: Lineage }
AttemptRecord  = { operation: OperationKey; outcome: "succeeded" | "failed" | "abandoned"; atMillis; lineage: Lineage }
HandbackRecord = { by; atMillis; note: string | null }
ParkRecord     = { reason: ParkReason; atMillis }               // §11's tagged set, with its payload
SourceRevision = { observed: string; processed: string | null } // engine-minted items only; null on a tracker ref

// engine
interface CoordinationView {                                     // folded; the handback barrier already applied
  claim: Claim | null; claimedByUs: boolean
  barrierAtMillis: number                                        // newest handback; 0 when none
  park: ParkRecord | null                                        // newest park after the barrier; a Claim clears it
  revision: SourceRevision | null
  counters(key: OperationKey): { consecutiveFailures: number; exhausted: boolean; hop: number; hopCapped: boolean }
  gate(key: OperationKey): Open | Claimed { claim } | Quiet | Parked { reason }   // Claimed → Quiet → Parked → Open
}
interface Coordination {
  fold(ledger: Ledger, claimant: string): CoordinationView       // pure; the one composition point (engine ADR 0011)
  read(ref): Effect<CoordinationView, CoordinationError>
  claim(ref, { operation; lineage }): Effect<Claim, CoordinationError>                       // claim-held | refused
  release(ref, claim): Effect<void, CoordinationError>                                        // stale-claim
  recordAttempt(ref, { operation; outcome; lineage; reason? }): Effect<CoordinationView, CoordinationError>
  park(ref, reason: ParkReason): Effect<CoordinationView, CoordinationError>
  handBack(ref, { by; note? }): Effect<CoordinationView, CoordinationError>
  observe(ref, revision: string, cause: Cause): Effect<"moved" | "redelivered", CoordinationError>   // minted items; not-this-authority on a tracker ref
  markProcessed(ref, revision: string): Effect<void, CoordinationError>
}
CoordinationError = { reason: "unavailable" | "refused" | "claim-held" | "stale-claim" | "not-this-authority"; retryable: boolean; message }
```

- Invariants: records are appended, never deleted; `fold` is total and deterministic and counts only records with `atMillis` after the barrier; `hop` on a Claim is the parent's depth plus one, so `hopCapped` is a field read; a record that does not decode is dropped at read and reported once (no legacy branch); a tracker ref's `read` reflects the newest poll, not a live fetch — a performance fact callers must know; writes return the post-write view so no caller computes `priorFailures + 1`.
- Behind the seam: the dispatch on the ref's kind (the only place origin is named); the marker wire codecs, comment ledger, claim label, and status text for a tracker item; the SQL tables and write gate for an engine-minted item; the barrier and all four counters, which deletes `exhaustion.ts`, `applyHandbackBarrier`, and the crash counter's own barrier read.
- Dependencies: the tracker port (true external) through the existing comment host, with the existing mock hosts in tests; the Control store (local-substitutable, internal seam); the clock (in-process).
- Tests: `fold` as tables (replaces `exhaustion.test.ts` and the barrier tests in `observe.test.ts`); one contract suite over `read` and the writes, **run once per authority layer** with the same assertions — the second run is the caller that makes the seam real.

#### 20.3 Trigger observation

A **Trigger source is a value**, not a service; one `TriggerObservation` module owns everything else.

```ts
interface TriggerSource {
  id: "github" | "linear" | "granola" | "slack" | "clock"
  entries: ReadonlyArray<TriggerEntry>                           // key, name, description, kind, requires, yields, parameters
  availability(entry: CatalogKey): Effect<Availability>          // never fails; reasons are data
  listOptions(entry, parameter, workspace?): Effect<Option[], SourceFailure>
  observe(subscriptions: ReadonlyArray<Subscription>): Stream<TriggerEvent, SourceFailure>
}
type Subscription = { entry: CatalogKey; parameters: { id; value }[]; workspaces: WorkspaceId[];   // already narrowed to ports binding the app
                      catchUp: { since: number } | null }                                           // occurrence: max(last seen, switch-on, now − window)
type TriggerEvent = { key: WorkItemRef; revision: string /* opaque; equality */; cause: Person | Cogwork { origin } | Unknown; atMillis; entry: CatalogKey; workspace: WorkspaceId | null }
SourceFailure = { reason: "auth" | "unavailable" | "rate-limited" | "decode" | "connection-not-ready"; retryAfterMillis: number | null; message }

interface TriggerObservation {
  eligible: Effect<ReadonlyArray<Admission>>                     // level read: observed ≠ processed, no claim; §6 order
  changes:  Stream<void>                                         // a tick after each admission; the scheduler may wake on it
  health:   Effect<ReadonlyArray<SourceHealth>>                  // one row per source → DaemonStatus
  catalog:  Effect<ReadonlyArray<CatalogEntry & { availability }>>
}
type Admission = { item: WorkItemRef; trigger: { workflow: WorkflowId; triggerId: Slug }; operation: OperationId; revision: string; lineage: Lineage }
```

- Invariants a source adapter must honour: `observe` runs only while called, with a non-empty set; the observer re-invokes it with the new set on every subscription change (publish, switch, Workspace change) and interrupts the previous run; a source writes nothing and holds no durable state (`catchUp` makes it stateless across restarts); an occurrence adapter emits nothing before `catchUp.since`; a condition adapter emits every matching item on every read; events may repeat, and admission is idempotent (same key and revision is a no-op, so push and poll cannot double-fire); a `Cogwork` cause on an ambient Slack entry moves nothing; a typed `SourceFailure` ends the stream and the observer alone restarts it — `rate-limited` sleeps `retryAfterMillis` for that source only, `connection-not-ready` waits for the Connection event; a defect is logged, counted, and restarted on a schedule; interruption is not a failure.
- Behind the seam: fan-in of the source streams; one supervised fiber per source in a `FiberMap`; subscription derivation from published, switched-on Workflows; the pure matcher (parameters AND, Triggers OR); admission through `Coordination.observe` and item minting; lineage seeding from cause; the single poll interval and per-source cooldown; catalog assembly; health projection.
- Dependencies: the five sources (`TriggerSources` is a `Context.Service<ReadonlyArray<TriggerSource>>`; five production values plus a `ScriptedSource` probe with `emit`, `fail`, and `subscriptions` — a real seam); each source's port or client is injected into that source's own Layer (true external; mocked in the source's own tests); the clock (in-process; `ClockSource` runs for real under `TestClock`); the Control store through `Coordination`; `DaemonEventBus`.
- Tests: the engine suite swaps one Layer (`ScriptedSource`) and asserts over `DaemonRpcs` — a redelivered event starts no Run, a source runs only while subscribed, an unready Connection pauses one source and `health` says so; `ClockSource` is tested under `TestClock` with no script; pagination, `since`, and decode are each source module's own tests at its internal seam.

