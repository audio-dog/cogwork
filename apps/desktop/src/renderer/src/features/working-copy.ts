import {
  adviseReadiness,
  applyWorkflowEdits,
  type MachineReadiness,
  validateWorkflow,
  type WorkflowCatalog,
  type WorkflowEdit,
  WorkflowEditBatch,
  type WorkflowId,
  type WorkflowRecord,
} from "@cogwork/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { WorkingCopyDaemon, WorkingCopyDaemonError } from "../daemon/working-copy-daemon";

export class WorkingCopyInputInvalid extends Schema.TaggedError<WorkingCopyInputInvalid>()(
  "WorkingCopyInputInvalid",
  { message: Schema.String },
) {}

export class WorkingCopyNotSaved extends Schema.TaggedError<WorkingCopyNotSaved>()("WorkingCopyNotSaved", {
  message: Schema.String,
}) {}

export type WorkingCopyInput = ReadonlyArray<typeof WorkflowEdit.Encoded>;

export type SaveStatus = "saved" | "not-saved";

export type PublishRefusal = "not-saved" | "stale-revision";

export interface WorkingCopySnapshot {
  readonly accepted: WorkflowRecord;
  readonly pending: ReadonlyArray<WorkflowEditBatch>;
  readonly saveStatus: SaveStatus;
  readonly publishRefusal: PublishRefusal | null;
}

export interface WorkingCopiesService {
  readonly edit: (
    id: WorkflowId,
    input: WorkingCopyInput,
  ) => Effect.Effect<WorkflowRecord, WorkingCopyInputInvalid | WorkingCopyDaemonError>;
  readonly publish: (
    id: WorkflowId,
  ) => Effect.Effect<WorkflowRecord, WorkingCopyNotSaved | WorkingCopyDaemonError>;
  readonly switchEnabled: (
    id: WorkflowId,
    enabled: boolean,
  ) => Effect.Effect<WorkflowRecord, WorkingCopyNotSaved | WorkingCopyDaemonError>;
  readonly snapshots: (id: WorkflowId) => Stream.Stream<WorkingCopySnapshot>;
}

export class WorkingCopies extends Context.Service<WorkingCopies, WorkingCopiesService>()(
  "@cogwork/desktop/features/working-copy/WorkingCopies",
) {}

interface PendingEdit {
  readonly edits: WorkflowEditBatch;
  readonly reply: Deferred.Deferred<WorkflowRecord, WorkingCopyDaemonError>;
}

interface SessionState {
  readonly pending: ReadonlyArray<PendingEdit>;
  readonly saveStatus: SaveStatus;
  readonly publishRefusal: PublishRefusal | null;
}

interface WorkingCopiesState {
  readonly records: ReadonlyMap<WorkflowId, WorkflowRecord>;
  readonly sessions: ReadonlyMap<WorkflowId, SessionState>;
}

interface Job<E> {
  readonly call: Effect.Effect<WorkflowRecord, E>;
  readonly settle: (exit: Exit.Exit<WorkflowRecord, E | WorkingCopyDaemonError>) => Effect.Effect<void>;
}

interface Session {
  readonly queue: Queue.Queue<Effect.Effect<void>>;
  readonly order: Semaphore.Semaphore;
}

interface SeenWorkingCopy {
  readonly accepted: WorkflowRecord | undefined;
  readonly earlier: ReadonlyArray<PendingEdit>;
}

const emptySession: SessionState = { pending: [], saveStatus: "saved", publishRefusal: null };

const sessionIdleTimeToLive = "1 minute";

const replyDeadline = "2 minutes";

const decodeEdits = Schema.decodeUnknownEffect(WorkflowEditBatch);

const withRecord = (state: WorkingCopiesState, record: WorkflowRecord): WorkingCopiesState => {
  const known = state.records.get(record.id);
  if (known && known.workingRevision > record.workingRevision) return state;
  return { ...state, records: new Map(state.records).set(record.id, record) };
};

const withSession = (
  state: WorkingCopiesState,
  id: WorkflowId,
  change: (session: SessionState) => SessionState,
): WorkingCopiesState => ({
  ...state,
  sessions: new Map(state.sessions).set(id, change(state.sessions.get(id) ?? emptySession)),
});

const withoutPending = (session: SessionState, entry: PendingEdit) =>
  session.pending.filter((pending) => pending !== entry);

const settledEdit = (
  state: WorkingCopiesState,
  id: WorkflowId,
  entry: PendingEdit,
  exit: Exit.Exit<WorkflowRecord, WorkingCopyDaemonError>,
) =>
  withSession(Exit.isSuccess(exit) ? withRecord(state, exit.value) : state, id, (session) => ({
    ...session,
    pending: withoutPending(session, entry),
    saveStatus: Exit.isSuccess(exit) ? "saved" : "not-saved",
  }));

export const publishRefusalOf = (error: unknown): PublishRefusal | null => {
  if (error instanceof WorkingCopyNotSaved) return "not-saved";
  return (error instanceof WorkingCopyDaemonError && error.reason) || null;
};

const settledPublish = (
  state: WorkingCopiesState,
  id: WorkflowId,
  exit: Exit.Exit<WorkflowRecord, unknown>,
) =>
  withSession(Exit.isSuccess(exit) ? withRecord(state, exit.value) : state, id, (session) => ({
    ...session,
    publishRefusal: Option.match(Exit.findErrorOption(exit), {
      onNone: () => null,
      onSome: publishRefusalOf,
    }),
  }));

const seenOf = (state: WorkingCopiesState, id: WorkflowId): SeenWorkingCopy => ({
  accepted: state.records.get(id),
  earlier: (state.sessions.get(id) ?? emptySession).pending,
});

const seenRevisionOf = (accepted: WorkflowRecord, replies: ReadonlyArray<WorkflowRecord>) =>
  accepted.workingRevision +
  replies.filter(({ workingRevision }) => workingRevision > accepted.workingRevision).length;

const snapshotOf = (record: WorkflowRecord, session: SessionState | undefined): WorkingCopySnapshot => ({
  accepted: record,
  pending: (session ?? emptySession).pending.map(({ edits }) => edits),
  saveStatus: (session ?? emptySession).saveStatus,
  publishRefusal: (session ?? emptySession).publishRefusal,
});

const needsPublishBeforeSwitch = (record: WorkflowRecord, enabled: boolean) =>
  enabled && record.publishedRevision === null;

const failureOf = <E>(cause: Cause.Cause<E>): E | WorkingCopyDaemonError =>
  Option.getOrElse(
    Cause.findErrorOption(cause),
    () => new WorkingCopyDaemonError({ message: Cause.pretty(cause) }),
  );

const runJob = <E>(job: Job<E>, reply: Deferred.Deferred<WorkflowRecord, E | WorkingCopyDaemonError>) =>
  job.call.pipe(
    Effect.catchCause((cause) => Effect.fail(failureOf(cause))),
    Effect.onExit((exit) => job.settle(exit).pipe(Effect.andThen(Deferred.done(reply, exit)))),
    Effect.ignore,
  );

export const make = Effect.gen(function* () {
  const daemon = yield* WorkingCopyDaemon;
  const state = yield* SubscriptionRef.make<WorkingCopiesState>({ records: new Map(), sessions: new Map() });
  const acceptRecord = (record: WorkflowRecord) =>
    SubscriptionRef.update(state, (current) => withRecord(current, record));
  yield* daemon.changes.pipe(Stream.runForEach(acceptRecord), Effect.forkScoped);

  const sessions = yield* RcMap.make({
    lookup: (id: WorkflowId) =>
      Queue.unbounded<Effect.Effect<void>>().pipe(
        Effect.tap((queue) => Queue.take(queue).pipe(Effect.flatten, Effect.forever, Effect.forkScoped)),
        Effect.tap(() =>
          Effect.addFinalizer(() =>
            SubscriptionRef.update(state, (current) => ({
              ...current,
              sessions: new Map([...current.sessions].filter(([open]) => open !== id)),
            })),
          ),
        ),
        Effect.flatMap((queue) => Effect.map(Semaphore.make(1), (order): Session => ({ queue, order }))),
      ),
    idleTimeToLive: sessionIdleTimeToLive,
  });

  const submit = <E>(
    id: WorkflowId,
    prepare: (reply: Deferred.Deferred<WorkflowRecord, E | WorkingCopyDaemonError>) => Effect.Effect<Job<E>>,
  ) =>
    Effect.scoped(
      Effect.all([RcMap.get(sessions, id), Deferred.make<WorkflowRecord, E | WorkingCopyDaemonError>()]).pipe(
        Effect.tap(([session, reply]) =>
          session.order.withPermits(1)(
            prepare(reply).pipe(Effect.flatMap((job) => Queue.offer(session.queue, runJob(job, reply)))),
          ),
        ),
        Effect.flatMap(([, reply]) => Deferred.await(reply)),
        Effect.timeoutOrElse({
          duration: replyDeadline,
          orElse: () =>
            Effect.fail(new WorkingCopyDaemonError({ message: `No reply within ${replyDeadline}` })),
        }),
      ),
    );

  const notLoaded = (id: WorkflowId) =>
    new WorkingCopyDaemonError({ message: `Workflow ${id} is not loaded` });

  const recordOf = (id: WorkflowId) =>
    Effect.flatMap(SubscriptionRef.get(state), ({ records }) => {
      const record = records.get(id);
      return record ? Effect.succeed(record) : Effect.fail(notLoaded(id));
    });

  const settlePublish = (id: WorkflowId) => (exit: Exit.Exit<WorkflowRecord, unknown>) =>
    SubscriptionRef.update(state, (current) => settledPublish(current, id, exit));

  const publishSeen = (id: WorkflowId, { accepted, earlier }: SeenWorkingCopy) =>
    Effect.forEach(earlier, ({ reply }) => Deferred.await(reply)).pipe(
      Effect.mapError(() => new WorkingCopyNotSaved({ message: "An earlier edit was not saved" })),
      Effect.flatMap((replies) =>
        accepted ? daemon.publish(id, seenRevisionOf(accepted, replies)) : Effect.fail(notLoaded(id)),
      ),
    );

  const edit = Effect.fn("WorkingCopies.edit")(function* (id: WorkflowId, input: WorkingCopyInput) {
    const edits = yield* decodeEdits(input, { onExcessProperty: "error" }).pipe(
      Effect.mapError((error) => new WorkingCopyInputInvalid({ message: error.message })),
    );
    return yield* submit(id, (reply: PendingEdit["reply"]) => {
      const entry: PendingEdit = { edits, reply };
      return SubscriptionRef.update(state, (current) =>
        withSession(current, id, (session) => ({ ...session, pending: [...session.pending, entry] })),
      ).pipe(
        Effect.as<Job<WorkingCopyDaemonError>>({
          call: daemon.edit(id, edits),
          settle: (exit) => SubscriptionRef.update(state, (current) => settledEdit(current, id, entry, exit)),
        }),
      );
    });
  });

  const publish = Effect.fn("WorkingCopies.publish")(function* (id: WorkflowId) {
    return yield* submit(id, () =>
      Effect.map(
        SubscriptionRef.get(state),
        (current): Job<WorkingCopyNotSaved | WorkingCopyDaemonError> => ({
          call: publishSeen(id, seenOf(current, id)),
          settle: settlePublish(id),
        }),
      ),
    );
  });

  const switchEnabled = Effect.fn("WorkingCopies.switchEnabled")(function* (
    id: WorkflowId,
    enabled: boolean,
  ) {
    return yield* submit(id, () =>
      Effect.map(
        SubscriptionRef.get(state),
        (current): Job<WorkingCopyNotSaved | WorkingCopyDaemonError> => ({
          call: recordOf(id).pipe(
            Effect.flatMap((record) =>
              needsPublishBeforeSwitch(record, enabled)
                ? publishSeen(id, seenOf(current, id)).pipe(Effect.flatMap(acceptRecord))
                : Effect.void,
            ),
            Effect.andThen(daemon.switchEnabled(id, enabled)),
          ),
          settle: settlePublish(id),
        }),
      ),
    );
  });

  const snapshots = (id: WorkflowId) =>
    Stream.unwrap(Effect.map(RcMap.get(sessions, id), () => SubscriptionRef.changes(state))).pipe(
      Stream.map(({ records, sessions }) => ({ record: records.get(id), session: sessions.get(id) })),
      Stream.changesWith((left, right) => left.record === right.record && left.session === right.session),
      Stream.flatMap(({ record, session }) =>
        record ? Stream.make(snapshotOf(record, session)) : Stream.empty,
      ),
    );

  return WorkingCopies.of({ edit, publish, switchEnabled, snapshots });
});

export const layer = Layer.effect(WorkingCopies, make);

export const viewOf = (
  snapshot: WorkingCopySnapshot,
  catalog: WorkflowCatalog | null,
  machine: MachineReadiness | null,
): WorkflowRecord => {
  const { accepted, pending } = snapshot;
  const [first, ...rest] = pending.flat();
  if (!first) return accepted;
  const applied = applyWorkflowEdits(accepted.workingCopy, [first, ...rest]);
  if (applied._tag !== "Ok") return accepted;
  return {
    ...accepted,
    workingCopy: applied.value,
    workingRevision: accepted.workingRevision + pending.length,
    diagnostics: catalog ? validateWorkflow(applied.value, catalog) : accepted.diagnostics,
    readiness: catalog && machine ? adviseReadiness(applied.value, catalog, machine) : accepted.readiness,
  };
};
