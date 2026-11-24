import {
  applyWorkflowEdits,
  WorkflowEditBatch,
  type WorkflowId,
  type WorkflowRecord,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { WorkingCopyDaemon, WorkingCopyDaemonError } from "../daemon/working-copy-daemon";

type DaemonCall =
  | { readonly _tag: "edit"; readonly id: WorkflowId; readonly edits: WorkflowEditBatch }
  | { readonly _tag: "publish"; readonly id: WorkflowId; readonly revision: number }
  | { readonly _tag: "switchEnabled"; readonly id: WorkflowId; readonly enabled: boolean };

export interface MemoryDaemonProbe {
  readonly seed: (record: WorkflowRecord) => Effect.Effect<void>;
  readonly editAsAnotherAuthor: (
    id: WorkflowId,
    edits: WorkflowEditBatch,
  ) => Effect.Effect<WorkflowRecord, WorkingCopyDaemonError>;
  readonly record: (id: WorkflowId) => Effect.Effect<WorkflowRecord | undefined>;
  readonly calls: Effect.Effect<ReadonlyArray<DaemonCall>>;
  readonly holdReplies: Effect.Effect<void>;
  readonly releaseReplies: Effect.Effect<void>;
  readonly holdDelivery: Effect.Effect<void>;
  readonly releaseDelivery: Effect.Effect<void>;
}

export class MemoryDaemon extends Context.Service<MemoryDaemon, MemoryDaemonProbe>()(
  "@cogwork/desktop/testing/working-copy-daemon/MemoryDaemon",
) {}

const encodeEdits = Schema.encodeEffect(WorkflowEditBatch);

const refused = (message: string) => new WorkingCopyDaemonError({ message });

const storedIn = (records: ReadonlyMap<WorkflowId, WorkflowRecord>, id: WorkflowId) => {
  const record = records.get(id);
  return record ? Effect.succeed(record) : Effect.fail(refused(`WorkflowNotFound ${id}`));
};

const editedRecord = (record: WorkflowRecord, edits: WorkflowEditBatch) => {
  const applied = applyWorkflowEdits(record.workingCopy, edits);
  return applied._tag === "Refused"
    ? Effect.fail(refused("WorkflowEditRefused"))
    : Effect.succeed({ ...record, workingCopy: applied.value, workingRevision: record.workingRevision + 1 });
};

const publishedRecord = (record: WorkflowRecord, revision: number) =>
  record.workingRevision === revision
    ? Effect.succeed({ ...record, publishedCopy: record.workingCopy, publishedRevision: revision })
    : Effect.fail(
        new WorkingCopyDaemonError({ message: "WorkflowPublishRefused", reason: "stale-revision" }),
      );

const switchedRecord = (record: WorkflowRecord, enabled: boolean) =>
  record.publishedRevision === null
    ? Effect.fail(refused("WorkflowSwitchRefused"))
    : Effect.succeed({ ...record, enabled });

export const memoryDaemonLayer = (records: ReadonlyArray<WorkflowRecord>) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const store = yield* SubscriptionRef.make<ReadonlyMap<WorkflowId, WorkflowRecord>>(
        new Map(records.map((record) => [record.id, record])),
      );
      const calls = yield* Ref.make<ReadonlyArray<DaemonCall>>([]);
      const replies = yield* Latch.make(true);
      const delivery = yield* Latch.make(true);

      const save = (record: WorkflowRecord) =>
        SubscriptionRef.update(store, (records) => new Map(records).set(record.id, record)).pipe(
          Effect.map(() => record),
        );
      const change = (
        id: WorkflowId,
        next: (record: WorkflowRecord) => Effect.Effect<WorkflowRecord, WorkingCopyDaemonError>,
      ) =>
        SubscriptionRef.get(store).pipe(
          Effect.flatMap((records) => storedIn(records, id)),
          Effect.flatMap(next),
          Effect.flatMap(save),
        );
      const answer = <A, E>(call: DaemonCall, reply: Effect.Effect<A, E>) =>
        Ref.update(calls, (made) => [...made, call]).pipe(
          Effect.andThen(replies.await),
          Effect.andThen(reply),
          Effect.tap(() => delivery.await),
        );

      const daemon = WorkingCopyDaemon.of({
        edit: (id, edits) =>
          answer(
            { _tag: "edit", id, edits },
            encodeEdits(edits, { onExcessProperty: "error" }).pipe(
              Effect.orDie,
              Effect.andThen(change(id, (record) => editedRecord(record, edits))),
            ),
          ),
        publish: (id, revision) =>
          answer(
            { _tag: "publish", id, revision },
            change(id, (record) => publishedRecord(record, revision)),
          ),
        switchEnabled: (id, enabled) =>
          answer(
            { _tag: "switchEnabled", id, enabled },
            change(id, (record) => switchedRecord(record, enabled)),
          ),
        changes: SubscriptionRef.changes(store).pipe(
          Stream.flatMap((records) => Stream.fromIterable(records.values())),
        ),
      });

      const probe = MemoryDaemon.of({
        seed: (record) => Effect.asVoid(save(record)),
        editAsAnotherAuthor: (id, edits) => change(id, (record) => editedRecord(record, edits)),
        record: (id) => Effect.map(SubscriptionRef.get(store), (records) => records.get(id)),
        calls: Ref.get(calls),
        holdReplies: Effect.asVoid(replies.close),
        releaseReplies: Effect.asVoid(replies.open),
        holdDelivery: Effect.asVoid(delivery.close),
        releaseDelivery: Effect.asVoid(delivery.open),
      });
      return Context.make(WorkingCopyDaemon, daemon).pipe(Context.add(MemoryDaemon, probe));
    }),
  );
