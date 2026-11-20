import {
  DaemonEvent,
  type WorkflowEditBatch,
  type WorkflowId,
  type WorkflowRecord,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { DaemonAtomRpc, daemonEventAtom, workflowsAtom } from "./atoms";

export class WorkingCopyDaemonError extends Schema.TaggedError<WorkingCopyDaemonError>()(
  "WorkingCopyDaemonError",
  { message: Schema.String },
) {}

export interface WorkingCopyDaemonService {
  readonly edit: (
    id: WorkflowId,
    edits: WorkflowEditBatch,
  ) => Effect.Effect<WorkflowRecord, WorkingCopyDaemonError>;
  readonly publish: (
    id: WorkflowId,
    revision: number,
  ) => Effect.Effect<WorkflowRecord, WorkingCopyDaemonError>;
  readonly switchEnabled: (
    id: WorkflowId,
    enabled: boolean,
  ) => Effect.Effect<WorkflowRecord, WorkingCopyDaemonError>;
  readonly changes: Stream.Stream<WorkflowRecord>;
}

export class WorkingCopyDaemon extends Context.Service<WorkingCopyDaemon, WorkingCopyDaemonService>()(
  "@cogwork/desktop/daemon/working-copy-daemon/WorkingCopyDaemon",
) {}

const daemonCallDeadline = "30 seconds";

export const boundDaemonCall = <A, E extends { readonly _tag: string; readonly message: string }>(
  call: Effect.Effect<A, E>,
) =>
  call.pipe(
    Effect.timeout(daemonCallDeadline),
    Effect.mapError((error) => new WorkingCopyDaemonError({ message: error.message || error._tag })),
  );

const recordsOf = (events: ReadonlyArray<DaemonEvent>) =>
  events.flatMap((event) => (DaemonEvent.guards.WorkflowChanged(event) ? [event.workflow] : []));

export const make = Effect.gen(function* () {
  const client = yield* DaemonAtomRpc;
  const registry = yield* AtomRegistry.AtomRegistry;
  const listed = AtomRegistry.toStream(registry, workflowsAtom).pipe(
    Stream.flatMap((result) =>
      Stream.fromIterable(AsyncResult.isSuccess(result) ? result.value.workflows : []),
    ),
  );
  const changed = AtomRegistry.toStream(registry, daemonEventAtom).pipe(
    Stream.flatMap((result) =>
      Stream.fromIterable(AsyncResult.isSuccess(result) ? recordsOf(result.value.items) : []),
    ),
  );
  return WorkingCopyDaemon.of({
    edit: (id, edits) => boundDaemonCall(client("EditWorkflow", { id, edits })),
    publish: (id, revision) => boundDaemonCall(client("PublishWorkflow", { id, revision })),
    switchEnabled: (id, enabled) =>
      boundDaemonCall(client("SwitchWorkflow", { id, enabled })).pipe(Effect.map(({ workflow }) => workflow)),
    changes: Stream.merge(listed, changed),
  });
});

export const layer = Layer.effect(WorkingCopyDaemon, make);
