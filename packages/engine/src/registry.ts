import {
  IssueTrackerConfig,
  SourceControlConfig,
  WorkspaceConfig,
  type WorkspaceFailureInfo,
  WorkspaceId,
  WorkspaceInput,
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
  type ControlStoreStatus,
  controlStoreClientLayer,
} from "./control-store";
import { emptyRegistry, type RegisteredWorkspace, type RegistryState } from "./projector";

export { emptyRegistry } from "./projector";
export type { RegisteredWorkspace, RegistryState };

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
}

export type WorkspaceRegistrationChange =
  | { readonly _tag: "Registered"; readonly workspace: RegisteredWorkspace }
  | { readonly _tag: "Failed"; readonly failure: WorkspaceFailureInfo };

export class WorkspaceManagement extends Context.Service<WorkspaceManagement, WorkspaceManagementService>()(
  "@cogwork/engine/registry/WorkspaceManagement",
) {}

export const managementReadOnlyLayer = Layer.succeed(WorkspaceManagement, {
  register: () => Effect.fail(new WorkspaceRegistrationError({ message: "Workspace registry is read-only" })),
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
const decodeSourceControl = Schema.decodeUnknownEffect(Schema.fromJsonString(SourceControlConfig));
const decodeWorkspaceInput = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkspaceInput));
const decodeWorkspaceConfig = Schema.decodeUnknownEffect(WorkspaceConfig);
const encodeIssueTracker = Schema.encodeSync(Schema.fromJsonString(IssueTrackerConfig));
const encodeSourceControl = Schema.encodeSync(Schema.fromJsonString(SourceControlConfig));

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const registrationError = (error: unknown) => new WorkspaceRegistrationError({ message: messageOf(error) });

const workspaceInputPath = (path: Path.Path, checkoutPath: string) =>
  path.join(checkoutPath, ".agents", workspaceInputName);

const present = <A>(value: A | null) => (value === null ? undefined : value);

const workspaceFailure = (row: WorkspaceRow, message: string) => {
  const name = Option.getOrUndefined(decodeWorkspaceIdOption(row.id));
  return {
    ...(name ? { name } : {}),
    source: row.checkoutPath,
    message,
  } satisfies WorkspaceFailureInfo;
};

export const findWorkspace = (registry: RegistryState, name: string) =>
  registry.workspaces.find(
    (workspace) => workspace.config.name === name || workspace.config.displayName === name,
  );

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

const loadState = Effect.fn("WorkspaceRegistry.loadState")(function* (store: ControlStoreStatus) {
  if (store.health === "unavailable") return emptyRegistry;
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

export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const path = yield* Path.Path;
    const store = yield* ControlStore;
    const dependencies = yield* Effect.context<FileSystem.FileSystem | Path.Path | SqlClient.SqlClient>();
    const initial = yield* loadState(store);
    const cell = MutableRef.make(initial);
    const revision = MutableRef.make(0);
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
      if (!path.isAbsolute(registration.checkoutPath)) {
        return yield* registrationError("Workspace checkout path must be absolute");
      }
      const existing = yield* selectWorkspaceBinding(registration.checkoutPath).pipe(
        Effect.provide(dependencies),
        Effect.mapError((error) => registrationError(error)),
      );
      if (existing) {
        return yield* registrationError(`Workspace checkout path is already registered as ${existing.id}`);
      }
      const id = yield* crypto.randomUUIDv7.pipe(
        Effect.flatMap(decodeWorkspaceId),
        Effect.mapError((error) => registrationError(error)),
      );
      const row = yield* insertWorkspace(id, registration).pipe(
        Effect.provide(dependencies),
        Effect.mapError((error) => registrationError(error)),
      );
      const change = yield* loadWorkspace(row).pipe(
        Effect.provide(dependencies),
        Effect.map((workspace) => ({ _tag: "Registered" as const, workspace })),
        Effect.catchTag("WorkspaceRegistrationError", (error) =>
          Effect.succeed({
            _tag: "Failed" as const,
            failure: workspaceFailure(row, error.message),
          }),
        ),
      );
      MutableRef.update(cell, (state) => foldRegistration(state, change));
      MutableRef.update(revision, (current) => current + 1);
      return change;
    });
    return Context.make(WorkspaceRegistry, registry).pipe(Context.add(WorkspaceManagement, { register }));
  }),
);

export const layerAt = (storePath: string) => {
  const client = controlStoreClientLayer(storePath);
  const store = bootControlStoreLayer(storePath).pipe(Layer.provide(client));
  return layer.pipe(Layer.provideMerge(store), Layer.provide(client));
};
