import {
  IssueTrackerConfig,
  SourceControlConfig,
  WorkspaceConfig,
  WorkspaceId,
  WorkspaceInput,
  WorkspaceManagementError,
  WorkspaceNotFound,
  type WorkspaceRegistration,
  WorkspaceRegistrationError,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  bootControlStoreLayer,
  ControlStore,
  type ControlStoreService,
  controlStoreClientLayer,
  readOnlyControlStoreClientLayer,
} from "./control-store";
import {
  emptyRegistry,
  type RegisteredWorkspace,
  type RegisteredWorkspaceFailure,
  type RegistryState,
  type WorkspaceIssueTrackerBinding,
} from "./projector";

export { emptyRegistry } from "./projector";
export type { RegisteredWorkspace, RegisteredWorkspaceFailure, RegistryState, WorkspaceIssueTrackerBinding };

export interface WorkspaceRegistryService extends RegistryState {
  readonly refresh: Effect.Effect<RegistryState, WorkspaceRegistrationError>;
}

export class WorkspaceRegistry extends Context.Service<WorkspaceRegistry, WorkspaceRegistryService>()(
  "@cogwork/engine/registry/WorkspaceRegistry",
) {}

export const readOnlyRegistry = (state: RegistryState): WorkspaceRegistryService => ({
  get workspaces() {
    return state.workspaces;
  },
  get failures() {
    return state.failures;
  },
  refresh: Effect.succeed(state),
});

export interface WorkspaceManagementService {
  readonly register: (
    registration: WorkspaceRegistration,
  ) => Effect.Effect<WorkspaceRegistrationChange, WorkspaceRegistrationError>;
  readonly deregister: (
    workspace: WorkspaceId,
  ) => Effect.Effect<WorkspaceId, WorkspaceManagementError | WorkspaceNotFound>;
  readonly rebind: (
    workspace: WorkspaceId,
    checkoutPath: string,
  ) => Effect.Effect<WorkspaceRegistrationChange, WorkspaceManagementError | WorkspaceNotFound>;
}

export type WorkspaceRegistrationChange =
  | { readonly _tag: "Registered"; readonly workspace: RegisteredWorkspace }
  | { readonly _tag: "Failed"; readonly failure: RegisteredWorkspaceFailure };

export class WorkspaceManagement extends Context.Service<WorkspaceManagement, WorkspaceManagementService>()(
  "@cogwork/engine/registry/WorkspaceManagement",
) {}

export const managementReadOnlyLayer = Layer.succeed(WorkspaceManagement, {
  register: () => Effect.fail(new WorkspaceRegistrationError({ message: "Workspace registry is read-only" })),
  deregister: () =>
    Effect.fail(
      new WorkspaceManagementError({
        operation: "deregister workspace",
        message: "Workspace registry is read-only",
      }),
    ),
  rebind: () =>
    Effect.fail(
      new WorkspaceManagementError({
        operation: "re-bind workspace",
        message: "Workspace registry is read-only",
      }),
    ),
});

interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
  readonly checkoutPath: string;
  readonly gitRemote: string | null;
  readonly issueTracker: string;
  readonly sourceControl: string | null;
  readonly linearHistory: number;
  readonly worktreeRoot: string | null;
  readonly worktreeRemote: string | null;
  readonly worktreeBaseBranch: string | null;
  readonly worktreeReapAfterMillis: number | null;
  readonly concurrency: number | null;
}

interface WorkspaceBindingRow {
  readonly id: string;
}

const workspaceInputName = "workspace.json";
const decodeWorkspaceId = Schema.decodeUnknownEffect(WorkspaceId);
const decodeWorkspaceIdOption = Schema.decodeUnknownOption(WorkspaceId);
const decodeIssueTracker = Schema.decodeUnknownEffect(Schema.fromJsonString(IssueTrackerConfig));
const decodeIssueTrackerOption = Schema.decodeUnknownOption(Schema.fromJsonString(IssueTrackerConfig));
const decodeSourceControl = Schema.decodeUnknownEffect(Schema.fromJsonString(SourceControlConfig));
const decodeWorkspaceInput = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceInput));
const decodeWorkspaceConfig = Schema.decodeUnknownEffect(WorkspaceConfig);
const encodeIssueTracker = Schema.encodeSync(Schema.fromJsonString(IssueTrackerConfig));
const encodeSourceControl = Schema.encodeSync(Schema.fromJsonString(SourceControlConfig));

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const registrationError = (error: unknown) => new WorkspaceRegistrationError({ message: messageOf(error) });

const isWorkspaceNotFound = Schema.is(WorkspaceNotFound);

const managementError = (operation: string) => (error: unknown) =>
  isWorkspaceNotFound(error) ? error : new WorkspaceManagementError({ operation, message: messageOf(error) });

const workspaceInputPath = (path: Path.Path, checkoutPath: string) =>
  path.join(checkoutPath, ".agents", workspaceInputName);

const present = <A>(value: A | null) => (value === null ? undefined : value);

const workspaceFailure = (row: WorkspaceRow, message: string) => {
  const name = Option.getOrUndefined(decodeWorkspaceIdOption(row.id));
  const issueTracker = Option.getOrUndefined(decodeIssueTrackerOption(row.issueTracker));
  return {
    ...(name ? { name } : {}),
    ...(issueTracker ? { issueTracker } : {}),
    displayName: row.name,
    source: row.checkoutPath,
    message,
    workspaceLimit: present(row.concurrency),
  } satisfies RegisteredWorkspaceFailure;
};

export const findWorkspace = (registry: RegistryState, name: string) =>
  registry.workspaces.find((workspace) => workspace.config.name === name);

export const findWorkspaceIssueTrackerBinding = (registry: RegistryState, name: string) => {
  const workspace = findWorkspace(registry, name);
  if (workspace !== undefined) return workspace;
  const failure = registry.failures.find((candidate) => candidate.name === name);
  if (failure?.name === undefined || failure.issueTracker === undefined) return undefined;
  return {
    config: { name: failure.name, issueTracker: failure.issueTracker },
  } satisfies WorkspaceIssueTrackerBinding;
};

export const findWorkspaceIssueTracker = (registry: RegistryState, name: string) =>
  findWorkspaceIssueTrackerBinding(registry, name)?.config.issueTracker;

const mergedWorktrees = (row: WorkspaceRow, input: WorkspaceInput) => {
  const root = present(row.worktreeRoot);
  const remote = present(row.worktreeRemote);
  const baseBranch = present(row.worktreeBaseBranch);
  const reapAfterMillis = present(row.worktreeReapAfterMillis);
  const linkPaths = input.worktrees?.linkPaths;
  const setup = input.worktrees?.setup;
  if (
    root === undefined &&
    remote === undefined &&
    baseBranch === undefined &&
    reapAfterMillis === undefined &&
    linkPaths === undefined &&
    setup === undefined
  ) {
    return undefined;
  }
  return {
    ...(root === undefined ? {} : { root }),
    ...(remote === undefined ? {} : { remote }),
    ...(baseBranch === undefined ? {} : { baseBranch }),
    ...(reapAfterMillis === undefined ? {} : { reapAfterMillis }),
    ...(linkPaths === undefined ? {} : { linkPaths }),
    ...(setup === undefined ? {} : { setup }),
  };
};

const loadWorkspace = Effect.fn("WorkspaceRegistry.loadWorkspace")(function* (row: WorkspaceRow) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inputPath = workspaceInputPath(path, row.checkoutPath);
  const input = yield* fs.readFileString(inputPath).pipe(
    Effect.flatMap(decodeWorkspaceInput),
    Effect.mapError((error) =>
      registrationError(`Cannot load Workspace input ${inputPath}: ${messageOf(error)}`),
    ),
  );
  const name = yield* decodeWorkspaceId(row.id).pipe(Effect.mapError((error) => registrationError(error)));
  const issueTracker = yield* decodeIssueTracker(row.issueTracker).pipe(
    Effect.mapError((error) => registrationError(error)),
  );
  const sourceControl =
    row.sourceControl === null
      ? undefined
      : yield* decodeSourceControl(row.sourceControl).pipe(
          Effect.mapError((error) => registrationError(error)),
        );
  const config = yield* decodeWorkspaceConfig({
    name,
    displayName: row.name,
    checkoutPath: row.checkoutPath,
    issueTracker,
    sourceControl,
    harness: input.harness,
    mcpSkills: input.mcpSkills,
    playbook: input.playbook,
    worktrees: mergedWorktrees(row, input),
    linearHistory: row.linearHistory === 1,
  }).pipe(Effect.mapError((error) => registrationError(error)));
  return {
    source: `control-store:${row.id}`,
    config,
    workspaceLimit: present(row.concurrency),
  } satisfies RegisteredWorkspace;
});

const selectRows = Effect.fn("WorkspaceRegistry.selectRows")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<WorkspaceRow>`SELECT
    id,
    name,
    checkout_path AS checkoutPath,
    git_remote AS gitRemote,
    issue_tracker AS issueTracker,
    source_control AS sourceControl,
    linear_history AS linearHistory,
    worktree_root AS worktreeRoot,
    worktree_remote AS worktreeRemote,
    worktree_base_branch AS worktreeBaseBranch,
    worktree_reap_after_millis AS worktreeReapAfterMillis,
    concurrency
  FROM workspaces
  ORDER BY id`;
});

const selectWorkspaceBinding = Effect.fn("WorkspaceRegistry.selectWorkspaceBinding")(function* (
  checkoutPath: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<WorkspaceBindingRow>`SELECT id
    FROM workspaces
    WHERE checkout_path = ${checkoutPath}
    LIMIT 1`;
  return row;
});

const selectWorkspaceRow = Effect.fn("WorkspaceRegistry.selectWorkspaceRow")(function* (
  workspace: WorkspaceId,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<WorkspaceRow>`SELECT
    id,
    name,
    checkout_path AS checkoutPath,
    git_remote AS gitRemote,
    issue_tracker AS issueTracker,
    source_control AS sourceControl,
    linear_history AS linearHistory,
    worktree_root AS worktreeRoot,
    worktree_remote AS worktreeRemote,
    worktree_base_branch AS worktreeBaseBranch,
    worktree_reap_after_millis AS worktreeReapAfterMillis,
    concurrency
  FROM workspaces
  WHERE id = ${workspace}
  LIMIT 1`;
  return row;
});

const updateCheckoutPath = Effect.fn("WorkspaceRegistry.updateCheckoutPath")(function* (
  workspace: WorkspaceId,
  checkoutPath: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE workspaces
    SET checkout_path = ${checkoutPath}
    WHERE id = ${workspace}`;
});

const loadRegistrationChange = Effect.fn("WorkspaceRegistry.loadRegistrationChange")(function* (
  row: WorkspaceRow,
) {
  return yield* loadWorkspace(row).pipe(
    Effect.map((workspace) => ({ _tag: "Registered" as const, workspace })),
    Effect.catchTag("WorkspaceRegistrationError", (error) =>
      Effect.succeed({ _tag: "Failed" as const, failure: workspaceFailure(row, error.message) }),
    ),
  );
});

const loadAvailableState = Effect.fn("WorkspaceRegistry.loadAvailableState")(function* () {
  const rows = yield* selectRows();
  const outcomes = yield* Effect.forEach(rows, (row) => Effect.result(loadWorkspace(row)));
  const workspaces = outcomes.flatMap((outcome) => (outcome._tag === "Success" ? [outcome.success] : []));
  const failures = outcomes.flatMap((outcome, index) => {
    if (outcome._tag === "Success") return [];
    const row = rows[index];
    if (!row) return [{ source: "Control store", message: outcome.failure.message }];
    return [workspaceFailure(row, outcome.failure.message)];
  });
  return { workspaces, failures } satisfies RegistryState;
});

const loadState = Effect.fn("WorkspaceRegistry.loadState")(function* (store: ControlStoreService) {
  if (store.health === "unavailable") return emptyRegistry;
  return yield* loadAvailableState();
});

const insertWorkspace = Effect.fn("WorkspaceRegistry.insertWorkspace")(function* (
  id: WorkspaceId,
  registration: WorkspaceRegistration,
) {
  const sql = yield* SqlClient.SqlClient;
  const worktrees = registration.worktrees;
  const [row] = yield* sql<WorkspaceRow>`INSERT INTO workspaces (
    id, name, checkout_path, git_remote, issue_tracker, source_control, linear_history,
    worktree_root, worktree_remote, worktree_base_branch, worktree_reap_after_millis, concurrency
  ) VALUES (
    ${id},
    ${registration.name},
    ${registration.checkoutPath},
    ${registration.gitRemote ?? null},
    ${encodeIssueTracker(registration.issueTracker)},
    ${registration.sourceControl ? encodeSourceControl(registration.sourceControl) : null},
    ${registration.linearHistory ? 1 : 0},
    ${worktrees?.root ?? null},
    ${worktrees?.remote ?? null},
    ${worktrees?.baseBranch ?? null},
    ${worktrees?.reapAfterMillis ?? null},
    ${registration.concurrency ?? null}
  ) RETURNING
    id,
    name,
    checkout_path AS checkoutPath,
    git_remote AS gitRemote,
    issue_tracker AS issueTracker,
    source_control AS sourceControl,
    linear_history AS linearHistory,
    worktree_root AS worktreeRoot,
    worktree_remote AS worktreeRemote,
    worktree_base_branch AS worktreeBaseBranch,
    worktree_reap_after_millis AS worktreeReapAfterMillis,
    concurrency`;
  if (!row) return yield* registrationError(`Workspace ${id} was not stored`);
  return row;
});

const withoutWorkspace = (state: RegistryState, name: WorkspaceId | undefined) => {
  if (!name) return state;
  return {
    workspaces: state.workspaces.filter((workspace) => workspace.config.name !== name),
    failures: state.failures.filter((failure) => failure.name !== name),
  };
};

const foldRegistration = (state: RegistryState, change: WorkspaceRegistrationChange) => {
  if (change._tag === "Registered") {
    const current = withoutWorkspace(state, change.workspace.config.name);
    return { ...current, workspaces: [...current.workspaces, change.workspace] };
  }
  const current = withoutWorkspace(state, change.failure.name);
  return { ...current, failures: [...current.failures, change.failure] };
};

export const layer = (storePath: string) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const path = yield* Path.Path;
      const privateWorkspaceRoot = path.join(path.dirname(storePath), "workspaces");
      const store = yield* ControlStore;
      const dependencies = yield* Effect.context<FileSystem.FileSystem | Path.Path | SqlClient.SqlClient>();
      const initial = yield* loadState(store);
      const cell = MutableRef.make(initial);
      const revision = MutableRef.make(0);
      const commitChange = (change: WorkspaceRegistrationChange) => {
        MutableRef.update(cell, (state) => foldRegistration(state, change));
        MutableRef.update(revision, (current) => current + 1);
        return change;
      };
      const commitRemoval = (workspace: WorkspaceId) => {
        MutableRef.update(cell, (state) => withoutWorkspace(state, workspace));
        MutableRef.update(revision, (current) => current + 1);
        return workspace;
      };
      const commitRefresh = (startedAt: number, state: RegistryState) => {
        if (MutableRef.get(revision) !== startedAt) return MutableRef.get(cell);
        MutableRef.set(cell, state);
        MutableRef.update(revision, (current) => current + 1);
        return state;
      };
      const registry: WorkspaceRegistryService = {
        get workspaces() {
          return MutableRef.get(cell).workspaces;
        },
        get failures() {
          return MutableRef.get(cell).failures;
        },
        refresh: Effect.sync(() => MutableRef.get(revision)).pipe(
          Effect.flatMap((startedAt) =>
            loadState(store).pipe(
              Effect.provide(dependencies),
              Effect.mapError((error) => registrationError(error)),
              Effect.map((state) => commitRefresh(startedAt, state)),
            ),
          ),
        ),
      };
      const register = Effect.fn("WorkspaceManagement.register")(function* (
        registration: WorkspaceRegistration,
      ) {
        if (store.health === "unavailable") return yield* registrationError(store.message);
        if (!path.isAbsolute(registration.checkoutPath)) {
          return yield* registrationError("Workspace checkout path must be absolute");
        }
        return yield* store.withWrite(
          Effect.gen(function* () {
            const normalizedRegistration = {
              ...registration,
              checkoutPath: path.resolve(registration.checkoutPath),
            };
            const existing = yield* selectWorkspaceBinding(normalizedRegistration.checkoutPath).pipe(
              Effect.provide(dependencies),
              Effect.mapError((error) => registrationError(error)),
            );
            if (existing) {
              return yield* registrationError(
                `Workspace checkout path is already registered as ${existing.id}`,
              );
            }
            const id = yield* crypto.randomUUIDv7.pipe(
              Effect.flatMap(decodeWorkspaceId),
              Effect.mapError((error) => registrationError(error)),
            );
            const row = yield* insertWorkspace(id, normalizedRegistration).pipe(
              Effect.provide(dependencies),
              Effect.mapError((error) => registrationError(error)),
            );
            const change = yield* loadRegistrationChange(row).pipe(Effect.provide(dependencies));
            return commitChange(change);
          }),
        );
      });
      const rebind = Effect.fn("WorkspaceManagement.rebind")(function* (
        workspace: WorkspaceId,
        checkoutPath: string,
      ) {
        if (store.health === "unavailable") {
          return yield* new WorkspaceManagementError({
            operation: "re-bind workspace",
            message: store.message,
          });
        }
        if (!path.isAbsolute(checkoutPath)) {
          return yield* new WorkspaceManagementError({
            operation: "re-bind workspace",
            message: "Workspace checkout path must be absolute",
          });
        }
        return yield* store.withWrite(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const normalizedPath = path.resolve(checkoutPath);
            const current = yield* selectWorkspaceRow(workspace);
            if (!current) return yield* new WorkspaceNotFound({ workspace });
            const existing = yield* selectWorkspaceBinding(normalizedPath);
            if (existing && existing.id !== workspace) {
              return yield* new WorkspaceManagementError({
                operation: "re-bind workspace",
                message: `Workspace checkout path is already registered as ${existing.id}`,
              });
            }
            yield* sql.withTransaction(updateCheckoutPath(workspace, normalizedPath));
            const change = yield* loadRegistrationChange({ ...current, checkoutPath: normalizedPath });
            return commitChange(change);
          }).pipe(Effect.provide(dependencies), Effect.mapError(managementError("re-bind workspace"))),
        );
      });
      const deregister = Effect.fn("WorkspaceManagement.deregister")(function* (workspace: WorkspaceId) {
        if (store.health === "unavailable") {
          return yield* new WorkspaceManagementError({
            operation: "deregister workspace",
            message: store.message,
          });
        }
        return yield* store.withWrite(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const sql = yield* SqlClient.SqlClient;
            const row = yield* selectWorkspaceRow(workspace);
            if (!row) return yield* new WorkspaceNotFound({ workspace });
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`DELETE FROM workspaces WHERE id = ${workspace}`;
                yield* fs.remove(path.join(privateWorkspaceRoot, workspace), {
                  recursive: true,
                  force: true,
                });
              }),
            );
            return commitRemoval(workspace);
          }).pipe(Effect.provide(dependencies), Effect.mapError(managementError("deregister workspace"))),
        );
      });
      return Context.make(WorkspaceRegistry, registry).pipe(
        Context.add(WorkspaceManagement, { register, deregister, rebind }),
      );
    }),
  );

export const layerAt = (storePath: string) => {
  const client = controlStoreClientLayer(storePath);
  const store = bootControlStoreLayer(storePath).pipe(Layer.provide(client));
  return layer(storePath).pipe(Layer.provideMerge(store), Layer.provide(client));
};

export const readOnlyLayerAt = (storePath: string) =>
  Layer.effect(
    WorkspaceRegistry,
    loadAvailableState().pipe(Effect.map(readOnlyRegistry), Effect.mapError(registrationError)),
  ).pipe(Layer.provide(readOnlyControlStoreClientLayer(storePath)));
