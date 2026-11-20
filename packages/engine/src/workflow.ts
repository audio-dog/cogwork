import {
  adviseReadiness,
  applyWorkflowEdits,
  ControlStoreFailure,
  HarnessModelOptionDescriptor,
  type MachineReadiness,
  Principal,
  PrincipalId as PrincipalIdSchema,
  validateWorkflow,
  validateWorkflowInput,
  type WorkflowCatalog,
  type WorkflowCatalogKey,
  type WorkflowCatalogResult,
  type WorkflowDiagnostic,
  type WorkflowDocument,
  WorkflowDocument as WorkflowDocumentSchema,
  type WorkflowEditBatch,
  WorkflowEditRefused,
  type WorkflowFailure,
  WorkflowFailure as WorkflowFailureSchema,
  type WorkflowId,
  WorkflowId as WorkflowIdSchema,
  type WorkflowList,
  WorkflowNotFound,
  type WorkflowOptionList,
  WorkflowPublishRefused,
  type WorkflowRecord,
  WorkflowRecord as WorkflowRecordSchema,
  WorkflowSwitchRefused,
  type WorkflowSwitchResult,
  type WorkflowTemplate,
  WorkflowUnreadable,
  type WorkspaceId,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ControlStore } from "./control-store";
import { DaemonEventBus } from "./daemon-event-bus";
import { Harness } from "./harness";
import { firstPartyInstructionPackages, WorkflowCatalogContributions } from "./workflow-catalog";
import { MachineReadinessSource } from "./workflow-machine-readiness";
import { makeWorkflowOptions } from "./workflow-options";

type WorkflowsError = ControlStoreFailure | WorkflowFailure;

export interface WorkflowsService {
  readonly create: (payload: {
    readonly document: WorkflowDocument;
  }) => Effect.Effect<WorkflowRecord, WorkflowsError, Principal>;
  readonly edit: (payload: {
    readonly id: WorkflowId;
    readonly edits: WorkflowEditBatch;
  }) => Effect.Effect<WorkflowRecord, WorkflowsError>;
  readonly publish: (payload: {
    readonly id: WorkflowId;
    readonly revision: number;
  }) => Effect.Effect<WorkflowRecord, WorkflowsError>;
  readonly switch: (payload: {
    readonly id: WorkflowId;
    readonly enabled: boolean;
  }) => Effect.Effect<WorkflowSwitchResult, WorkflowsError>;
  readonly delete: (payload: { readonly id: WorkflowId }) => Effect.Effect<WorkflowId, WorkflowsError>;
  readonly list: Effect.Effect<WorkflowList, ControlStoreFailure>;
  readonly get: (payload: { readonly id: WorkflowId }) => Effect.Effect<WorkflowRecord, WorkflowsError>;
  readonly validate: (payload: {
    readonly document: unknown;
  }) => Effect.Effect<ReadonlyArray<WorkflowDiagnostic>>;
  readonly catalog: Effect.Effect<WorkflowCatalogResult>;
  readonly templates: Effect.Effect<ReadonlyArray<WorkflowTemplate>>;
  readonly listOptions: (payload: {
    readonly entry: WorkflowCatalogKey;
    readonly parameter: string;
    readonly workspaces: ReadonlyArray<WorkspaceId>;
  }) => Effect.Effect<WorkflowOptionList>;
}

const unavailableFailure = ControlStoreFailure.make({
  operation: "read Workflows",
  message: "Workflows unavailable",
  retryable: true,
});

const unavailableWorkflows: WorkflowsService = {
  create: () => Effect.fail(unavailableFailure),
  edit: () => Effect.fail(unavailableFailure),
  publish: () => Effect.fail(unavailableFailure),
  switch: () => Effect.fail(unavailableFailure),
  delete: () => Effect.fail(unavailableFailure),
  list: Effect.fail(unavailableFailure),
  get: () => Effect.fail(unavailableFailure),
  validate: () => Effect.succeed([]),
  catalog: Effect.succeed({
    catalog: { entries: [], instructionPackages: [], harnesses: [] },
    machine: {
      workspaces: [],
      connections: [],
      harnesses: [],
      defaultHarness: null,
      readyNeeds: [],
    },
  }),
  templates: Effect.succeed([]),
  listOptions: () => Effect.succeed([]),
};

export const Workflows = Context.Reference<WorkflowsService>("@cogwork/engine/workflow/Workflows", {
  defaultValue: () => unavailableWorkflows,
});

const WorkflowDocumentJson = Schema.fromJsonString(WorkflowDocumentSchema);
const encodeWorkflowDocument = Schema.encodeEffect(WorkflowDocumentJson);
const decodeStoredWorkflow = Schema.decodeUnknownEffect(
  Schema.Struct({
    id: Schema.String,
    principal: Schema.String,
    working_copy: Schema.String,
    working_revision: Schema.Int,
    published_copy: Schema.NullOr(Schema.String),
    published_revision: Schema.NullOr(Schema.Int),
    enabled: Schema.Union([Schema.Boolean, Schema.Literals([0, 1])]),
  }),
);
type StoredWorkflowRow = Effect.Success<ReturnType<typeof decodeStoredWorkflow>>;
type StoredWorkflowInput = Record<string, unknown>;

const isWorkflowFailure = Schema.is(WorkflowFailureSchema);
const messageRules = [
  {
    matches: (error: unknown) => error instanceof Error,
    make: (error: unknown) => (error as Error).message,
  },
  {
    matches: (error: unknown) => typeof error === "object" && error !== null && "message" in error,
    make: (error: unknown) => String((error as { readonly message: unknown }).message),
  },
];

const messageOf = (error: unknown) =>
  messageRules.find(({ matches }) => matches(error))?.make(error) ?? String(error);

const storeFailure = (operation: string) => (error: unknown) =>
  ControlStoreFailure.make({ operation, message: messageOf(error), retryable: true });

const workflowFailure = (operation: string) => (error: unknown) =>
  isWorkflowFailure(error) ? error : storeFailure(operation)(error);

const storedWorkflowId = (row: StoredWorkflowInput) => (typeof row.id === "string" ? row.id : "<unreadable>");

const blockingDiagnostics = (record: WorkflowRecord) =>
  record.diagnostics.filter(({ class: diagnosticClass }) => diagnosticClass !== "advisory");

const modelOptions = (options: ReadonlyArray<HarnessModelOptionDescriptor>) =>
  options.map((option) =>
    HarnessModelOptionDescriptor.match(option, {
      boolean: ({ id }) => ({ id, values: [true, false] }),
      select: ({ id, values }) => ({ id, values: values.map(({ value }) => value) }),
    }),
  );

const catalogOf = (
  contributions: typeof WorkflowCatalogContributions.Service,
  harness: typeof Harness.Service,
): WorkflowCatalog => ({
  entries: contributions.flatMap(({ entries }) => entries),
  instructionPackages: firstPartyInstructionPackages,
  harnesses: [...harness.catalogs].map(([name, catalog]) => ({
    name,
    models: catalog.models.map(({ value: id, options = [] }) => ({ id, options: modelOptions(options) })),
  })),
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ControlStore;
  const bus = yield* DaemonEventBus;
  const contributions = yield* WorkflowCatalogContributions;
  const machineSource = yield* MachineReadinessSource;
  const harness = yield* Harness;
  const catalog = catalogOf(contributions, harness);
  const templates = contributions.flatMap((contribution) => contribution.templates);
  const options = makeWorkflowOptions(contributions.flatMap((contribution) => contribution.options ?? []));
  const unavailable = ControlStoreFailure.make({
    operation: "read Workflows",
    message: store.health === "unavailable" ? store.message : "Control store unavailable",
    retryable: true,
  });
  const requireStore = store.health === "available" ? Effect.void : Effect.fail(unavailable);

  const readStoredWorkflows = Effect.fn("Workflows.readRows")(function* () {
    return yield* sql<StoredWorkflowInput>`
      SELECT id, principal, working_copy, working_revision, published_copy, published_revision, enabled
      FROM workflows
      ORDER BY id
    `;
  });

  const readStoredWorkflow = Effect.fn("Workflows.readRow")(function* (id: WorkflowId) {
    const rows = yield* sql<StoredWorkflowInput>`
      SELECT id, principal, working_copy, working_revision, published_copy, published_revision, enabled
      FROM workflows
      WHERE id = ${id}
    `;
    const row = rows[0];
    if (row) return row;
    return yield* new WorkflowNotFound({ id });
  });

  const decodeRecord = Effect.fn("Workflows.decodeRecord")(function* (
    row: StoredWorkflowRow,
    machine: MachineReadiness,
  ) {
    const id = yield* Schema.decodeEffect(WorkflowIdSchema)(row.id);
    const principal = yield* Schema.decodeEffect(PrincipalIdSchema)(row.principal);
    const workingCopy = yield* Schema.decodeEffect(WorkflowDocumentJson)(row.working_copy);
    const publishedCopy =
      row.published_copy === null
        ? null
        : yield* Schema.decodeEffect(WorkflowDocumentJson)(row.published_copy);
    return yield* Schema.decodeEffect(WorkflowRecordSchema)({
      id,
      principal,
      workingCopy,
      workingRevision: row.working_revision,
      publishedCopy,
      publishedRevision: row.published_revision,
      enabled: row.enabled === true || row.enabled === 1,
      diagnostics: validateWorkflow(workingCopy, catalog),
      readiness: adviseReadiness(workingCopy, catalog, machine),
    });
  });

  const decodeRecordFor = (id: WorkflowId, machine: MachineReadiness) => (row: StoredWorkflowInput) =>
    decodeStoredWorkflow(row).pipe(
      Effect.flatMap((stored) => decodeRecord(stored, machine)),
      Effect.mapError((error) => new WorkflowUnreadable({ id, message: messageOf(error) })),
    );

  const getRecord = Effect.fn("Workflows.getRecord")(function* (id: WorkflowId, machine: MachineReadiness) {
    const row = yield* readStoredWorkflow(id);
    return yield* decodeRecordFor(id, machine)(row);
  });

  const publishChanged = (workflow: WorkflowRecord) => bus.publish({ _tag: "WorkflowChanged", workflow });

  const publishDeleted = (id: WorkflowId) => bus.publish({ _tag: "WorkflowDeleted", id });

  const writeAndPublish = <A, E>(write: Effect.Effect<A, E>, publish: (value: A) => Effect.Effect<unknown>) =>
    store.withWrite(Effect.uninterruptibleMask((restore) => restore(write).pipe(Effect.tap(publish))));

  const listWorkflows = Effect.fn("Workflows.list")(function* () {
    yield* requireStore;
    const machine = yield* machineSource.current;
    const rows = yield* readStoredWorkflows();
    const [workflows, unreadable] = yield* Effect.partition(rows, (row) => {
      const id = storedWorkflowId(row);
      return Schema.decodeEffect(WorkflowIdSchema)(id).pipe(
        Effect.flatMap((workflowId) => decodeRecordFor(workflowId, machine)(row)),
        Effect.mapError((error) => ({ id, message: messageOf(error) })),
      );
    });
    return { workflows, unreadable } satisfies WorkflowList;
  });

  const get = Effect.fn("Workflows.get")(function* (payload: { readonly id: WorkflowId }) {
    yield* requireStore;
    return yield* getRecord(payload.id, yield* machineSource.current);
  });

  const create = Effect.fn("Workflows.create")(function* (payload: { readonly document: WorkflowDocument }) {
    yield* requireStore;
    const diagnostics = validateWorkflow(payload.document, catalog);
    const malformed = diagnostics.filter(({ class: diagnosticClass }) => diagnosticClass === "malformed");
    if (malformed.length > 0) return yield* new WorkflowEditRefused({ diagnostics: malformed });
    const principal = yield* Principal;
    const machine = yield* machineSource.current;
    const write = sql.withTransaction(
      Schema.decodeEffect(WorkflowIdSchema)(SecureRandom.uuidV4Unsafe()).pipe(
        Effect.flatMap((id) =>
          encodeWorkflowDocument(payload.document).pipe(
            Effect.tap(
              (workingCopy) => sql`
                INSERT INTO workflows (
                  id, principal, working_copy, working_revision, published_copy, published_revision, enabled
                ) VALUES (${id}, ${principal.id}, ${workingCopy}, 1, NULL, NULL, 0)
              `,
            ),
            Effect.andThen(getRecord(id, machine)),
          ),
        ),
      ),
    );
    return yield* writeAndPublish(write, publishChanged);
  });

  const editTransaction = Effect.fn("Workflows.editTransaction")(function* (
    payload: { readonly id: WorkflowId; readonly edits: WorkflowEditBatch },
    machine: MachineReadiness,
  ) {
    const current = yield* getRecord(payload.id, machine);
    const applied = applyWorkflowEdits(current.workingCopy, payload.edits);
    if (applied._tag === "Refused") {
      return yield* new WorkflowEditRefused({ diagnostics: applied.diagnostics });
    }
    const diagnostics = validateWorkflow(applied.value, catalog);
    const malformed = diagnostics.filter(({ class: diagnosticClass }) => diagnosticClass === "malformed");
    if (malformed.length > 0) return yield* new WorkflowEditRefused({ diagnostics: malformed });
    const workingCopy = yield* encodeWorkflowDocument(applied.value);
    yield* sql`
      UPDATE workflows
      SET working_copy = ${workingCopy}, working_revision = working_revision + 1
      WHERE id = ${payload.id}
    `;
    return {
      ...current,
      workingCopy: applied.value,
      workingRevision: current.workingRevision + 1,
      diagnostics,
      readiness: adviseReadiness(applied.value, catalog, machine),
    } satisfies WorkflowRecord;
  });

  const edit = Effect.fn("Workflows.edit")(
    (payload: { readonly id: WorkflowId; readonly edits: WorkflowEditBatch }) =>
      requireStore.pipe(
        Effect.andThen(machineSource.current),
        Effect.flatMap((machine) =>
          writeAndPublish(sql.withTransaction(editTransaction(payload, machine)), publishChanged),
        ),
      ),
  );

  const publishTransaction = Effect.fn("Workflows.publishTransaction")(function* (
    payload: { readonly id: WorkflowId; readonly revision: number },
    machine: MachineReadiness,
  ) {
    const current = yield* getRecord(payload.id, machine);
    const blocking = blockingDiagnostics(current);
    const refusal = [
      {
        matches: payload.revision !== current.workingRevision,
        reason: "stale-revision" as const,
        diagnostics: current.diagnostics,
      },
      {
        matches: blocking.length > 0,
        reason: "incomplete" as const,
        diagnostics: blocking,
      },
    ].find(({ matches }) => matches);
    if (refusal) {
      return yield* new WorkflowPublishRefused({
        reason: refusal.reason,
        expectedRevision: payload.revision,
        actualRevision: current.workingRevision,
        diagnostics: refusal.diagnostics,
      });
    }
    const publishedCopy = yield* encodeWorkflowDocument(current.workingCopy);
    yield* sql`
      UPDATE workflows
      SET published_copy = ${publishedCopy}, published_revision = ${current.workingRevision}
      WHERE id = ${payload.id}
    `;
    return yield* getRecord(payload.id, machine);
  });

  const publish = Effect.fn("Workflows.publish")(
    (payload: { readonly id: WorkflowId; readonly revision: number }) =>
      requireStore.pipe(
        Effect.andThen(machineSource.current),
        Effect.flatMap((machine) =>
          writeAndPublish(sql.withTransaction(publishTransaction(payload, machine)), publishChanged),
        ),
      ),
  );

  const switchTransaction = Effect.fn("Workflows.switchTransaction")(function* (
    payload: { readonly id: WorkflowId; readonly enabled: boolean },
    machine: MachineReadiness,
  ) {
    const current = yield* getRecord(payload.id, machine);
    if (payload.enabled && current.publishedRevision === null) {
      return yield* new WorkflowSwitchRefused({ id: payload.id, reason: "no-published-revision" });
    }
    yield* sql`UPDATE workflows SET enabled = ${payload.enabled ? 1 : 0} WHERE id = ${payload.id}`;
    return yield* getRecord(payload.id, machine);
  });

  const switchWorkflow = Effect.fn("Workflows.switch")(function* (payload: {
    readonly id: WorkflowId;
    readonly enabled: boolean;
  }) {
    yield* requireStore;
    const machine = yield* machineSource.current;
    const workflow = yield* writeAndPublish(
      sql.withTransaction(switchTransaction(payload, machine)),
      publishChanged,
    );
    return { workflow, matchingItems: 0 } satisfies WorkflowSwitchResult;
  });

  const deleteTransaction = Effect.fn("Workflows.deleteTransaction")(function* (id: WorkflowId) {
    yield* sql`UPDATE workflows SET enabled = 0 WHERE id = ${id}`;
    const deleted = yield* sql<{ readonly id: string }>`
      DELETE FROM workflows WHERE id = ${id} RETURNING id
    `;
    if (deleted.length === 0) return yield* new WorkflowNotFound({ id });
    return id;
  });

  const deleteWorkflow = Effect.fn("Workflows.delete")(function* (payload: { readonly id: WorkflowId }) {
    yield* requireStore;
    return yield* writeAndPublish(sql.withTransaction(deleteTransaction(payload.id)), publishDeleted);
  });

  const listOptions = (payload: {
    readonly entry: WorkflowCatalogKey;
    readonly parameter: string;
    readonly workspaces: ReadonlyArray<WorkspaceId>;
  }) => {
    const entry = catalog.entries.find(({ key }) => key === payload.entry);
    return entry ? options.list(entry, payload.parameter, payload.workspaces) : Effect.succeed([]);
  };

  return {
    create: (payload) => create(payload).pipe(Effect.mapError(workflowFailure("create Workflow"))),
    edit: (payload) => edit(payload).pipe(Effect.mapError(workflowFailure("edit Workflow"))),
    publish: (payload) => publish(payload).pipe(Effect.mapError(workflowFailure("publish Workflow"))),
    switch: (payload) => switchWorkflow(payload).pipe(Effect.mapError(workflowFailure("switch Workflow"))),
    delete: (payload) => deleteWorkflow(payload).pipe(Effect.mapError(workflowFailure("delete Workflow"))),
    list: listWorkflows().pipe(Effect.mapError(storeFailure("list Workflows"))),
    get: (payload) => get(payload).pipe(Effect.mapError(workflowFailure("get Workflow"))),
    validate: ({ document }) => Effect.succeed(validateWorkflowInput(document, catalog)),
    catalog: machineSource.current.pipe(Effect.map((machine) => ({ catalog, machine }))),
    templates: Effect.succeed(templates),
    listOptions,
  } satisfies WorkflowsService;
});

export const layer = Layer.effect(Workflows, make);
