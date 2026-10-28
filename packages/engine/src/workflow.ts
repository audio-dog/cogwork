import {
  Principal,
  validateWorkflowInput,
  type WorkflowDocument,
  type WorkflowEdit,
  type WorkflowId,
  type WorkflowRecord,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import { WorkflowStore } from "./control-store";
import { DaemonEventBus } from "./daemon-event-bus";
import { workflowCatalog } from "./workflow-catalog";

export const listWorkflows = Effect.fn("Daemon.ListWorkflows")(function* () {
  return yield* (yield* WorkflowStore).listWorkflows(workflowCatalog);
});

export const getWorkflow = Effect.fn("Daemon.GetWorkflow")(function* (payload: { readonly id: WorkflowId }) {
  return yield* (yield* WorkflowStore).getWorkflow(payload.id, workflowCatalog);
});

export const validateWorkflowDocument = Effect.fn("Daemon.ValidateWorkflow")(
  (payload: { readonly document: unknown }) =>
    Effect.succeed(validateWorkflowInput(payload.document, workflowCatalog)),
);

export const getWorkflowCatalog = Effect.fn("Daemon.GetWorkflowCatalog")(() =>
  Effect.succeed(workflowCatalog),
);

const publishChanged = Effect.fn("Daemon.publishWorkflowChanged")(function* (workflow: WorkflowRecord) {
  return yield* (yield* DaemonEventBus).publish({ _tag: "WorkflowChanged", workflow });
});

const publishAfterWrite = Effect.fn("Daemon.publishAfterWorkflowWrite")(function* <A, E, R, E2, R2>(
  write: Effect.Effect<A, E, R>,
  publish: (written: A) => Effect.Effect<unknown, E2, R2>,
) {
  return yield* Effect.uninterruptibleMask((restore) => restore(write).pipe(Effect.tap(publish)));
});

const writeWorkflow = Effect.fn("Daemon.writeWorkflow")(function* <E, R>(
  write: Effect.Effect<WorkflowRecord, E, R>,
) {
  const store = yield* WorkflowStore;
  return yield* store.withWrite(publishAfterWrite(write, publishChanged));
});

export const createWorkflow = Effect.fn("Daemon.CreateWorkflow")(function* (payload: {
  readonly document: WorkflowDocument;
}) {
  const store = yield* WorkflowStore;
  const principal = yield* Principal;
  return yield* writeWorkflow(store.createWorkflow(principal.id, payload.document, workflowCatalog));
});

export const editWorkflow = Effect.fn("Daemon.EditWorkflow")(function* (payload: {
  readonly id: WorkflowId;
  readonly edits: ReadonlyArray<WorkflowEdit>;
}) {
  const store = yield* WorkflowStore;
  return yield* writeWorkflow(store.editWorkflow(payload.id, payload.edits, workflowCatalog));
});

export const publishWorkflow = Effect.fn("Daemon.PublishWorkflow")(function* (payload: {
  readonly id: WorkflowId;
  readonly revision: number;
}) {
  const store = yield* WorkflowStore;
  return yield* writeWorkflow(store.publishWorkflow(payload.id, payload.revision, workflowCatalog));
});

export const switchWorkflow = Effect.fn("Daemon.SwitchWorkflow")(function* (payload: {
  readonly id: WorkflowId;
  readonly enabled: boolean;
}) {
  const store = yield* WorkflowStore;
  const workflow = yield* writeWorkflow(store.switchWorkflow(payload.id, payload.enabled, workflowCatalog));
  return { workflow, matchingItems: 0 };
});

export const deleteWorkflow = Effect.fn("Daemon.DeleteWorkflow")(function* (payload: {
  readonly id: WorkflowId;
}) {
  const store = yield* WorkflowStore;
  return yield* store.withWrite(
    publishAfterWrite(store.deleteWorkflow(payload.id), (id) =>
      Effect.flatMap(DaemonEventBus, (bus) => bus.publish({ _tag: "WorkflowDeleted", id })),
    ),
  );
});
