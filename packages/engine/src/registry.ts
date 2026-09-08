import {
  IssueTrackerConfig,
  McpSkill,
  SourceControlConfig,
  TrimmedNonEmptyString,
  WorkspaceConfig,
  WorkspaceId,
  WorkspaceManagementError,
  WorkspaceNotFound,
  WorkspaceRegistration,
  WorkspaceRegistrationError,
  type WorkspaceUpdate,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { type ScanAuthoringTreesRequest, scanAuthoringTrees } from "./authoring-tree";
import { bootControlStoreLayer, ControlStore, readOnlyControlStoreClientLayer } from "./control-store";
import {
  emptyRegistry,
  type RegisteredWorkspace,
  type RegisteredWorkspaceFailure,
  type RegistryState,
  type WorkspaceIssueTrackerBinding,
} from "./projector";

export { emptyRegistry } from "./projector";
export type { RegisteredWorkspace, RegisteredWorkspaceFailure, RegistryState, WorkspaceIssueTrackerBinding };

interface AuthoringRoots {
  readonly cogworkHome: string;
  readonly userAgentsDir?: string;
}

type AuthoringTreeScanner = (
  request: ScanAuthoringTreesRequest,
) => Effect.Effect<
  Effect.Success<ReturnType<typeof scanAuthoringTrees>>,
  Effect.Error<ReturnType<typeof scanAuthoringTrees>>
>;

interface WorkspaceLoadingServices {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly scanAuthoringTrees: AuthoringTreeScanner;
}

export interface WorkspaceRegistryService {
  readonly state: Effect.Effect<RegistryState>;
  readonly refresh: Effect.Effect<RegistryState, WorkspaceRegistrationError>;
}

export class WorkspaceRegistry extends Context.Service<WorkspaceRegistry, WorkspaceRegistryService>()(
  "@cogwork/engine/registry/WorkspaceRegistry",
) {}

export const readOnlyRegistry = (state: RegistryState): WorkspaceRegistryService => ({
  state: Effect.succeed(state),
  refresh: Effect.succeed(state),
});

export interface WorkspaceManagementService {
  readonly register: (
    registration: WorkspaceRegistration,
  ) => Effect.Effect<WorkspaceRegistrationChange, WorkspaceRegistrationError>;
  readonly deregister: (
    workspace: WorkspaceId,
  ) => Effect.Effect<WorkspaceId, WorkspaceManagementError | WorkspaceNotFound>;
  readonly update: (
    workspace: WorkspaceId,
    update: WorkspaceUpdate,
  ) => Effect.Effect<WorkspaceRegistrationChange, WorkspaceManagementError | WorkspaceNotFound>;
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
  update: () =>
    Effect.fail(
      new WorkspaceManagementError({
        operation: "update workspace",
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
  readonly mcpSkills: string | null;
  readonly linearHistory: number;
  readonly worktreeRoot: string | null;
  readonly worktreeRemote: string | null;
  readonly worktreeBaseBranch: string | null;
  readonly worktreeLinkPaths: string | null;
  readonly worktreeSetup: string | null;
  readonly worktreeReapAfterMillis: number | null;
  readonly concurrency: number | null;
}

interface WorkspaceIdentityRow {
  readonly id: string;
}

const McpSkills = Schema.Array(McpSkill);
const WorktreeValues = Schema.Array(TrimmedNonEmptyString);
const WorkspaceBindingColumns = Schema.Struct({
  mcpSkills: Schema.NullOr(Schema.fromJsonString(McpSkills)),
  worktreeLinkPaths: Schema.NullOr(Schema.fromJsonString(WorktreeValues)),
  worktreeSetup: Schema.NullOr(Schema.fromJsonString(WorktreeValues)),
});
const decodeWorkspaceId = Schema.decodeUnknownEffect(WorkspaceId);
const decodeWorkspaceIdOption = Schema.decodeUnknownOption(WorkspaceId);
const decodeIssueTracker = Schema.decodeUnknownEffect(Schema.fromJsonString(IssueTrackerConfig));
const decodeIssueTrackerOption = Schema.decodeUnknownOption(Schema.fromJsonString(IssueTrackerConfig));
const decodeSourceControl = Schema.decodeUnknownEffect(Schema.fromJsonString(SourceControlConfig));
const decodeSourceControlOption = Schema.decodeUnknownOption(Schema.fromJsonString(SourceControlConfig));
const decodeWorkspaceBindingColumns = Schema.decodeUnknownEffect(WorkspaceBindingColumns);
const decodeWorkspaceConfig = Schema.decodeUnknownEffect(WorkspaceConfig);
const decodeWorkspaceRegistration = Schema.decodeUnknownEffect(WorkspaceRegistration);
const encodeIssueTracker = Schema.encodeSync(Schema.fromJsonString(IssueTrackerConfig));
const encodeSourceControl = Schema.encodeSync(Schema.fromJsonString(SourceControlConfig));
const encodeMcpSkills = Schema.encodeSync(Schema.fromJsonString(McpSkills));
const encodeWorktreeValues = Schema.encodeSync(Schema.fromJsonString(WorktreeValues));

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const registrationError = (error: unknown) => new WorkspaceRegistrationError({ message: messageOf(error) });

const isWorkspaceNotFound = Schema.is(WorkspaceNotFound);

const managementError = (operation: string) => (error: unknown) =>
  isWorkspaceNotFound(error) ? error : new WorkspaceManagementError({ operation, message: messageOf(error) });

const present = <A>(value: A | null) => (value === null ? undefined : value);

const workspaceFailure = (row: WorkspaceRow, message: string) => {
  const name = Option.getOrUndefined(decodeWorkspaceIdOption(row.id));
  const issueTracker = Option.getOrUndefined(decodeIssueTrackerOption(row.issueTracker));
  const sourceControl = Option.getOrUndefined(decodeSourceControlOption(row.sourceControl));
  return {
    ...(name ? { name } : {}),
    ...(issueTracker ? { issueTracker } : {}),
    ...(sourceControl ? { sourceControl } : {}),
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

const worktreesFrom = (row: WorkspaceRow, binding: typeof WorkspaceBindingColumns.Type) => {
  const root = present(row.worktreeRoot);
  const remote = present(row.worktreeRemote);
  const baseBranch = present(row.worktreeBaseBranch);
  const reapAfterMillis = present(row.worktreeReapAfterMillis);
  const linkPaths = present(binding.worktreeLinkPaths);
  const setup = present(binding.worktreeSetup);
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

const loadWorkspace = Effect.fn("WorkspaceRegistry.loadWorkspace")(function* (
  services: WorkspaceLoadingServices,
  row: WorkspaceRow,
  authoringRoots: AuthoringRoots,
) {
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
  const binding = yield* decodeWorkspaceBindingColumns(row).pipe(
    Effect.mapError((error) => registrationError(error)),
  );
  const record = yield* decodeWorkspaceRegistration({
    name: row.name,
    checkoutPath: row.checkoutPath,
    gitRemote: present(row.gitRemote),
    issueTracker,
    sourceControl,
    mcpSkills: present(binding.mcpSkills),
    worktrees: worktreesFrom(row, binding),
    linearHistory: row.linearHistory === 1,
    concurrency: present(row.concurrency),
  }).pipe(Effect.mapError((error) => registrationError(error)));
  const config = yield* decodeWorkspaceConfig({
    name,
    displayName: record.name,
    checkoutPath: record.checkoutPath,
    issueTracker: record.issueTracker,
    sourceControl: record.sourceControl,
    mcpSkills: record.mcpSkills,
    worktrees: record.worktrees,
    linearHistory: record.linearHistory,
  }).pipe(Effect.mapError((error) => registrationError(error)));
  const contributions = yield* services
    .scanAuthoringTrees({
      workspace: name,
      repoRoot: row.checkoutPath,
      ...authoringRoots,
    })
    .pipe(Effect.mapError(registrationError));
  return {
    source: `control-store:${row.id}`,
    config,
    record,
    contributions,
    workspaceLimit: present(row.concurrency),
  } satisfies RegisteredWorkspace;
});

const selectRows = Effect.fn("WorkspaceRegistry.selectRows")(function* (sql: SqlClient.SqlClient) {
  return yield* sql<WorkspaceRow>`SELECT
    id,
    name,
    checkout_path AS checkoutPath,
    git_remote AS gitRemote,
    issue_tracker AS issueTracker,
    source_control AS sourceControl,
    mcp_skills AS mcpSkills,
    linear_history AS linearHistory,
    worktree_root AS worktreeRoot,
    worktree_remote AS worktreeRemote,
    worktree_base_branch AS worktreeBaseBranch,
    worktree_link_paths AS worktreeLinkPaths,
    worktree_setup AS worktreeSetup,
    worktree_reap_after_millis AS worktreeReapAfterMillis,
    concurrency
  FROM workspaces
  ORDER BY id`;
});

const selectWorkspaceBinding = Effect.fn("WorkspaceRegistry.selectWorkspaceBinding")(function* (
  sql: SqlClient.SqlClient,
  checkoutPath: string,
) {
  const [row] = yield* sql<WorkspaceIdentityRow>`SELECT id
    FROM workspaces
    WHERE checkout_path = ${checkoutPath}
    LIMIT 1`;
  return row;
});

const selectWorkspaceRow = Effect.fn("WorkspaceRegistry.selectWorkspaceRow")(function* (
  sql: SqlClient.SqlClient,
  workspace: WorkspaceId,
) {
  const [row] = yield* sql<WorkspaceRow>`SELECT
    id,
    name,
    checkout_path AS checkoutPath,
    git_remote AS gitRemote,
    issue_tracker AS issueTracker,
    source_control AS sourceControl,
    mcp_skills AS mcpSkills,
    linear_history AS linearHistory,
    worktree_root AS worktreeRoot,
    worktree_remote AS worktreeRemote,
    worktree_base_branch AS worktreeBaseBranch,
    worktree_link_paths AS worktreeLinkPaths,
    worktree_setup AS worktreeSetup,
    worktree_reap_after_millis AS worktreeReapAfterMillis,
    concurrency
  FROM workspaces
  WHERE id = ${workspace}
  LIMIT 1`;
  return row;
});

const updateCheckoutPath = Effect.fn("WorkspaceRegistry.updateCheckoutPath")(function* (
  sql: SqlClient.SqlClient,
  workspace: WorkspaceId,
  checkoutPath: string,
) {
  yield* sql`UPDATE workspaces
    SET checkout_path = ${checkoutPath}
    WHERE id = ${workspace}`;
});

const updateWorkspaceRow = Effect.fn("WorkspaceRegistry.updateWorkspaceRow")(function* (
  sql: SqlClient.SqlClient,
  workspace: WorkspaceId,
  update: WorkspaceUpdate,
) {
  const worktrees = update.worktrees;
  const [row] = yield* sql<WorkspaceRow>`UPDATE workspaces SET
    name = ${update.name},
    git_remote = ${update.gitRemote ?? null},
    issue_tracker = ${encodeIssueTracker(update.issueTracker)},
    source_control = ${update.sourceControl ? encodeSourceControl(update.sourceControl) : null},
    mcp_skills = ${update.mcpSkills ? encodeMcpSkills(update.mcpSkills) : null},
    linear_history = ${update.linearHistory ? 1 : 0},
    worktree_root = ${worktrees?.root ?? null},
    worktree_remote = ${worktrees?.remote ?? null},
    worktree_base_branch = ${worktrees?.baseBranch ?? null},
    worktree_link_paths = ${worktrees?.linkPaths ? encodeWorktreeValues(worktrees.linkPaths) : null},
    worktree_setup = ${worktrees?.setup ? encodeWorktreeValues(worktrees.setup) : null},
    worktree_reap_after_millis = ${worktrees?.reapAfterMillis ?? null},
    concurrency = ${update.concurrency ?? null}
    WHERE id = ${workspace}
    RETURNING
      id,
      name,
      checkout_path AS checkoutPath,
      git_remote AS gitRemote,
      issue_tracker AS issueTracker,
      source_control AS sourceControl,
      mcp_skills AS mcpSkills,
      linear_history AS linearHistory,
      worktree_root AS worktreeRoot,
      worktree_remote AS worktreeRemote,
      worktree_base_branch AS worktreeBaseBranch,
      worktree_link_paths AS worktreeLinkPaths,
      worktree_setup AS worktreeSetup,
      worktree_reap_after_millis AS worktreeReapAfterMillis,
      concurrency`;
  if (!row) return yield* new WorkspaceNotFound({ workspace });
  return row;
});

const loadRegistrationChange = Effect.fn("WorkspaceRegistry.loadRegistrationChange")(function* (
  services: WorkspaceLoadingServices,
  row: WorkspaceRow,
  authoringRoots: AuthoringRoots,
) {
  return yield* loadWorkspace(services, row, authoringRoots).pipe(
    Effect.map((workspace) => ({ _tag: "Registered" as const, workspace })),
    Effect.catchTag("WorkspaceRegistrationError", (error) =>
      Effect.succeed({ _tag: "Failed" as const, failure: workspaceFailure(row, error.message) }),
    ),
  );
});

const loadAvailableState = Effect.fn("WorkspaceRegistry.loadAvailableState")(function* (
  sql: SqlClient.SqlClient,
  services: WorkspaceLoadingServices,
  authoringRoots: AuthoringRoots,
) {
  const rows = yield* selectRows(sql);
  const outcomes = yield* Effect.forEach(rows, (row) =>
    Effect.result(loadWorkspace(services, row, authoringRoots)),
  );
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
  sql: SqlClient.SqlClient,
  id: WorkspaceId,
  registration: WorkspaceRegistration,
) {
  const worktrees = registration.worktrees;
  const [row] = yield* sql<WorkspaceRow>`INSERT INTO workspaces (
    id, name, checkout_path, git_remote, issue_tracker, source_control, mcp_skills, linear_history,
    worktree_root, worktree_remote, worktree_base_branch, worktree_link_paths, worktree_setup,
    worktree_reap_after_millis, concurrency
  ) VALUES (
    ${id},
    ${registration.name},
    ${registration.checkoutPath},
    ${registration.gitRemote ?? null},
    ${encodeIssueTracker(registration.issueTracker)},
    ${registration.sourceControl ? encodeSourceControl(registration.sourceControl) : null},
    ${registration.mcpSkills ? encodeMcpSkills(registration.mcpSkills) : null},
    ${registration.linearHistory ? 1 : 0},
    ${worktrees?.root ?? null},
    ${worktrees?.remote ?? null},
    ${worktrees?.baseBranch ?? null},
    ${worktrees?.linkPaths ? encodeWorktreeValues(worktrees.linkPaths) : null},
    ${worktrees?.setup ? encodeWorktreeValues(worktrees.setup) : null},
    ${worktrees?.reapAfterMillis ?? null},
    ${registration.concurrency ?? null}
  ) RETURNING
    id,
    name,
    checkout_path AS checkoutPath,
    git_remote AS gitRemote,
    issue_tracker AS issueTracker,
    source_control AS sourceControl,
    mcp_skills AS mcpSkills,
    linear_history AS linearHistory,
    worktree_root AS worktreeRoot,
    worktree_remote AS worktreeRemote,
    worktree_base_branch AS worktreeBaseBranch,
    worktree_link_paths AS worktreeLinkPaths,
    worktree_setup AS worktreeSetup,
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

export const layer = (controlStorePath: string, userAgentsDir: string) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ControlStore;
      const cogworkHome = path.dirname(controlStorePath);
      const authoringRoots = { cogworkHome, userAgentsDir };
      const privateWorkspaceRoot = path.join(cogworkHome, "workspaces");
      const loadingServices = {
        fileSystem: fs,
        path,
        scanAuthoringTrees: (request: ScanAuthoringTreesRequest) =>
          scanAuthoringTrees(request).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
      } satisfies WorkspaceLoadingServices;
      const loadState = Effect.fn("WorkspaceRegistry.loadState")(function* () {
        if (store.health === "unavailable") return emptyRegistry;
        return yield* loadAvailableState(sql, loadingServices, authoringRoots);
      });
      const initial = yield* loadState();
      const cell = yield* Ref.make({ state: initial, revision: 0 });
      const commitChange = Effect.fn("WorkspaceRegistry.commitChange")(
        (change: WorkspaceRegistrationChange) =>
          Ref.modify(cell, (current) => [
            change,
            {
              state: foldRegistration(current.state, change),
              revision: current.revision + 1,
            },
          ]),
      );
      const commitRemoval = (workspace: WorkspaceId) =>
        Ref.modify(cell, (current) => [
          workspace,
          {
            state: withoutWorkspace(current.state, workspace),
            revision: current.revision + 1,
          },
        ]);
      const commitRefresh = (expectedRevision: number, state: RegistryState) =>
        Ref.modify(cell, (current) => {
          if (current.revision !== expectedRevision) return [current.state, current];
          return [state, { state, revision: current.revision + 1 }];
        });
      const registry: WorkspaceRegistryService = {
        state: Ref.get(cell).pipe(Effect.map((current) => current.state)),
        refresh: Ref.get(cell).pipe(
          Effect.flatMap(({ revision }) =>
            loadState().pipe(
              Effect.mapError((error) => registrationError(error)),
              Effect.flatMap((state) => commitRefresh(revision, state)),
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
        const normalizedRegistration = {
          ...registration,
          checkoutPath: path.resolve(registration.checkoutPath),
        };
        return yield* store.withWrite(
          selectWorkspaceBinding(sql, normalizedRegistration.checkoutPath).pipe(
            Effect.mapError((error) => registrationError(error)),
            Effect.flatMap((existing) => {
              if (existing) {
                return registrationError(`Workspace checkout path is already registered as ${existing.id}`);
              }
              return crypto.randomUUIDv7.pipe(
                Effect.flatMap(decodeWorkspaceId),
                Effect.mapError((error) => registrationError(error)),
              );
            }),
            Effect.flatMap((id) =>
              insertWorkspace(sql, id, normalizedRegistration).pipe(
                Effect.mapError((error) => registrationError(error)),
              ),
            ),
            Effect.flatMap((row) => loadRegistrationChange(loadingServices, row, authoringRoots)),
            Effect.flatMap(commitChange),
          ),
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
        const normalizedPath = path.resolve(checkoutPath);
        return yield* store.withWrite(
          selectWorkspaceRow(sql, workspace).pipe(
            Effect.flatMap(
              (
                current,
              ): Effect.Effect<WorkspaceRegistrationChange, WorkspaceManagementError | WorkspaceNotFound> => {
                if (!current) return Effect.fail(new WorkspaceNotFound({ workspace }));
                return selectWorkspaceBinding(sql, normalizedPath).pipe(
                  Effect.flatMap(
                    (
                      existing,
                    ): Effect.Effect<
                      WorkspaceRegistrationChange,
                      WorkspaceManagementError | WorkspaceNotFound
                    > => {
                      if (existing && existing.id !== workspace) {
                        return Effect.fail(
                          new WorkspaceManagementError({
                            operation: "re-bind workspace",
                            message: `Workspace checkout path is already registered as ${existing.id}`,
                          }),
                        );
                      }
                      return sql
                        .withTransaction(updateCheckoutPath(sql, workspace, normalizedPath))
                        .pipe(
                          Effect.andThen(
                            loadRegistrationChange(
                              loadingServices,
                              { ...current, checkoutPath: normalizedPath },
                              authoringRoots,
                            ),
                          ),
                          Effect.flatMap(commitChange),
                          Effect.mapError(managementError("re-bind workspace")),
                        );
                    },
                  ),
                  Effect.mapError(managementError("re-bind workspace")),
                );
              },
            ),
            Effect.mapError(managementError("re-bind workspace")),
          ),
        );
      });
      const update = Effect.fn("WorkspaceManagement.update")(function* (
        workspace: WorkspaceId,
        workspaceUpdate: WorkspaceUpdate,
      ) {
        if (store.health === "unavailable") {
          return yield* new WorkspaceManagementError({
            operation: "update workspace",
            message: store.message,
          });
        }
        return yield* store.withWrite(
          sql.withTransaction(updateWorkspaceRow(sql, workspace, workspaceUpdate)).pipe(
            Effect.flatMap((row) => loadRegistrationChange(loadingServices, row, authoringRoots)),
            Effect.flatMap(commitChange),
            Effect.mapError(managementError("update workspace")),
          ),
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
          selectWorkspaceRow(sql, workspace).pipe(
            Effect.flatMap(
              (row): Effect.Effect<WorkspaceId, WorkspaceManagementError | WorkspaceNotFound> => {
                if (!row) return Effect.fail(new WorkspaceNotFound({ workspace }));
                return sql
                  .withTransaction(
                    sql`DELETE FROM contribution_settings
                    WHERE scope = 'private-workspace-overlay'
                      AND workspace = ${workspace}`.pipe(
                      Effect.andThen(sql`DELETE FROM operation_settings
                      WHERE scope = 'private-workspace-overlay'
                        AND workspace = ${workspace}`),
                      Effect.andThen(sql`DELETE FROM workspaces WHERE id = ${workspace}`),
                      Effect.andThen(
                        fs.remove(path.join(privateWorkspaceRoot, workspace), {
                          recursive: true,
                          force: true,
                        }),
                      ),
                    ),
                  )
                  .pipe(
                    Effect.andThen(commitRemoval(workspace)),
                    Effect.mapError(managementError("deregister workspace")),
                  );
              },
            ),
            Effect.mapError(managementError("deregister workspace")),
          ),
        );
      });
      return Context.make(WorkspaceRegistry, registry).pipe(
        Context.add(WorkspaceManagement, { register, update, deregister, rebind }),
      );
    }),
  );

export const layerAt = (storePath: string, userAgentsDir = `${storePath}.agents`) => {
  const store = bootControlStoreLayer(storePath);
  return layer(storePath, userAgentsDir).pipe(Layer.provideMerge(store));
};

export const readOnlyLayerAt = (storePath: string) =>
  Layer.effect(
    WorkspaceRegistry,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const loadingServices = {
        fileSystem: fs,
        path,
        scanAuthoringTrees: (request: ScanAuthoringTreesRequest) =>
          scanAuthoringTrees(request).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
      } satisfies WorkspaceLoadingServices;
      return readOnlyRegistry(
        yield* loadAvailableState(sql, loadingServices, { cogworkHome: path.dirname(storePath) }),
      );
    }).pipe(Effect.mapError(registrationError)),
  ).pipe(Layer.provide(readOnlyControlStoreClientLayer(storePath)));
