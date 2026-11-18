import {
  IssueTrackerConfig,
  McpSkill,
  SourceControlConfig,
  TrimmedNonEmptyString,
  WorkspaceConfig,
  WorkspaceId,
  WorkspaceRegistration,
  WorkspaceRegistrationError,
  WorkspaceRegistryError,
  type WorkspaceUpdate,
} from "@cogwork/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { type ScanAuthoringTreesRequest, scanAuthoringTrees } from "./authoring-tree";
import { bootControlStoreLayer, ControlStore, readOnlyControlStoreClientLayer } from "./control-store";
import { Git, type GitError } from "./git";
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
  readonly remoteUrl: (checkoutPath: string, remote: string) => Effect.Effect<string, GitError>;
  readonly scanAuthoringTrees: AuthoringTreeScanner;
}

interface LoadedWorkspaceInput {
  readonly name: WorkspaceId;
  readonly issueTracker: IssueTrackerConfig;
  readonly sourceControl?: SourceControlConfig;
  readonly repository?: string;
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
  readonly deregister: (workspace: WorkspaceId) => Effect.Effect<WorkspaceId, WorkspaceRegistryError>;
  readonly update: (
    workspace: WorkspaceId,
    update: WorkspaceUpdate,
  ) => Effect.Effect<WorkspaceRegistrationChange, WorkspaceRegistryError>;
  readonly rebind: (
    workspace: WorkspaceId,
    checkoutPath: string,
  ) => Effect.Effect<WorkspaceRegistrationChange, WorkspaceRegistryError>;
}

export type WorkspaceRegistrationChange =
  | { readonly _tag: "Registered"; readonly workspace: RegisteredWorkspace }
  | { readonly _tag: "Failed"; readonly failure: RegisteredWorkspaceFailure };

export class WorkspaceManagement extends Context.Service<WorkspaceManagement, WorkspaceManagementService>()(
  "@cogwork/engine/registry/WorkspaceManagement",
) {}

const workspaceNotFound = (workspace: WorkspaceId) =>
  new WorkspaceRegistryError({
    reason: "not-found",
    workspace,
    message: `Workspace "${workspace}" not found`,
  });

const workspaceManagementFailure = (workspace: WorkspaceId, operation: string, message: string) =>
  new WorkspaceRegistryError({ reason: "management-failed", workspace, operation, message });

export const managementReadOnlyLayer = Layer.succeed(WorkspaceManagement, {
  register: () => Effect.fail(new WorkspaceRegistrationError({ message: "Workspace registry is read-only" })),
  deregister: (workspace) =>
    Effect.fail(
      workspaceManagementFailure(workspace, "deregister workspace", "Workspace registry is read-only"),
    ),
  update: (workspace) =>
    Effect.fail(workspaceManagementFailure(workspace, "update workspace", "Workspace registry is read-only")),
  rebind: (workspace) =>
    Effect.fail(
      workspaceManagementFailure(workspace, "re-bind workspace", "Workspace registry is read-only"),
    ),
});

interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
  readonly checkoutPath: string;
  readonly lastRepository: string | null;
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
const LegacyGitHubRepository = Schema.Struct({
  type: Schema.Literal("github"),
  repo: TrimmedNonEmptyString,
});
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
const decodeLegacyGitHubRepositoryOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(LegacyGitHubRepository),
);
const decodeWorkspaceBindingColumns = Schema.decodeUnknownEffect(WorkspaceBindingColumns);
const decodeWorkspaceConfig = Schema.decodeUnknownEffect(WorkspaceConfig);
const decodeWorkspaceRegistration = Schema.decodeUnknownEffect(WorkspaceRegistration);
const encodeIssueTracker = Schema.encodeSync(Schema.fromJsonString(IssueTrackerConfig));
const encodeSourceControl = Schema.encodeSync(Schema.fromJsonString(SourceControlConfig));
const encodeMcpSkills = Schema.encodeSync(Schema.fromJsonString(McpSkills));
const encodeWorktreeValues = Schema.encodeSync(Schema.fromJsonString(WorktreeValues));

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const registrationError = (error: unknown) => new WorkspaceRegistrationError({ message: messageOf(error) });

const isWorkspaceRegistryError = Schema.is(WorkspaceRegistryError);

const managementError = (workspace: WorkspaceId, operation: string) => (error: unknown) =>
  isWorkspaceRegistryError(error)
    ? error
    : workspaceManagementFailure(workspace, operation, messageOf(error));

const present = <A>(value: A | null) => (value === null ? undefined : value);

const legacyRepository = (row: WorkspaceRow) =>
  Option.getOrUndefined(decodeLegacyGitHubRepositoryOption(row.issueTracker))?.repo ??
  Option.getOrUndefined(decodeLegacyGitHubRepositoryOption(row.sourceControl))?.repo;

const repositoryFromRemoteUrl = (remoteUrl: string) => {
  const match =
    /^(?:https:\/\/(?:[^/?#@\s]+@)?github\.com\/|ssh:\/\/(?:git@)?(?:github\.com(?::\d+)?|ssh\.github\.com:443)\/|git@github\.com:)([^/?#\s]+)\/([^/?#\s]+)\/?$/i.exec(
      remoteUrl.trim(),
    );
  if (!match) return null;
  const owner = match[1];
  const name = match[2]?.replace(/\.git$/i, "");
  if (!owner || !name) return null;
  return `${owner}/${name}`;
};

const repositoryRequired = (
  issueTracker: IssueTrackerConfig,
  sourceControl: SourceControlConfig | undefined,
) => issueTracker.type === "github" || sourceControl?.type === "github";

const loadRepository = Effect.fn("WorkspaceRegistry.loadRepository")(function* (
  services: WorkspaceLoadingServices,
  row: WorkspaceRow,
  issueTracker: IssueTrackerConfig,
  sourceControl: SourceControlConfig | undefined,
) {
  if (!repositoryRequired(issueTracker, sourceControl)) return undefined;
  const remote = row.worktreeRemote ?? "origin";
  const remoteUrl = yield* services.remoteUrl(row.checkoutPath, remote).pipe(
    Effect.mapError(
      (error) =>
        new WorkspaceRegistrationError({
          message: `Cannot read GitHub repository from remote "${remote}" at ${row.checkoutPath}: ${messageOf(error)}`,
        }),
    ),
  );
  const repository = repositoryFromRemoteUrl(remoteUrl);
  if (repository) return repository;
  return yield* new WorkspaceRegistrationError({
    message: `Remote "${remote}" at ${row.checkoutPath} is not a supported GitHub SSH or HTTPS remote`,
  });
});

const workspaceFailure = (row: WorkspaceRow, message: string, repository?: string) => {
  const name = Option.getOrUndefined(decodeWorkspaceIdOption(row.id));
  const issueTracker = Option.getOrUndefined(decodeIssueTrackerOption(row.issueTracker));
  const sourceControl = Option.getOrUndefined(decodeSourceControlOption(row.sourceControl));
  return {
    ...(name ? { name } : {}),
    ...(issueTracker ? { issueTracker } : {}),
    ...(sourceControl ? { sourceControl } : {}),
    ...(repository ? { repository } : {}),
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
    ...(failure.repository ? { repository: failure.repository } : {}),
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

const loadWorkspaceInput = Effect.fn("WorkspaceRegistry.loadWorkspaceInput")(function* (
  services: WorkspaceLoadingServices,
  row: WorkspaceRow,
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
  const repository = yield* loadRepository(services, row, issueTracker, sourceControl);
  return { name, issueTracker, sourceControl, repository } satisfies LoadedWorkspaceInput;
});

const loadWorkspace = Effect.fn("WorkspaceRegistry.loadWorkspace")(function* (
  services: WorkspaceLoadingServices,
  row: WorkspaceRow,
  authoringRoots: AuthoringRoots,
  input: LoadedWorkspaceInput,
) {
  const binding = yield* decodeWorkspaceBindingColumns(row).pipe(
    Effect.mapError((error) => registrationError(error)),
  );
  const record = yield* decodeWorkspaceRegistration({
    name: row.name,
    checkoutPath: row.checkoutPath,
    issueTracker: input.issueTracker,
    sourceControl: input.sourceControl,
    mcpSkills: present(binding.mcpSkills),
    worktrees: worktreesFrom(row, binding),
    linearHistory: row.linearHistory === 1,
    concurrency: present(row.concurrency),
  }).pipe(Effect.mapError((error) => registrationError(error)));
  const config = yield* decodeWorkspaceConfig({
    name: input.name,
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
      workspace: input.name,
      repoRoot: row.checkoutPath,
      ...authoringRoots,
    })
    .pipe(Effect.mapError(registrationError));
  return {
    source: `control-store:${row.id}`,
    ...(input.repository ? { repository: input.repository } : {}),
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
    last_repository AS lastRepository,
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
    last_repository AS lastRepository,
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

const rebindWorkspaceRow = Effect.fn("WorkspaceRegistry.rebindWorkspaceRow")(function* (
  sql: SqlClient.SqlClient,
  workspace: WorkspaceId,
  checkoutPath: string,
) {
  const current = yield* selectWorkspaceRow(sql, workspace);
  if (!current) return yield* workspaceNotFound(workspace);
  const existing = yield* selectWorkspaceBinding(sql, checkoutPath);
  if (existing && existing.id !== workspace) {
    return yield* workspaceManagementFailure(
      workspace,
      "re-bind workspace",
      `Workspace checkout path is already registered as ${existing.id}`,
    );
  }
  yield* sql.withTransaction(updateCheckoutPath(sql, workspace, checkoutPath));
  return { ...current, checkoutPath };
});

const updateWorkspaceRow = Effect.fn("WorkspaceRegistry.updateWorkspaceRow")(function* (
  sql: SqlClient.SqlClient,
  workspace: WorkspaceId,
  update: WorkspaceUpdate,
) {
  const worktrees = update.worktrees;
  const [row] = yield* sql<WorkspaceRow>`UPDATE workspaces SET
    name = ${update.name},
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
      last_repository AS lastRepository,
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
  if (!row) return yield* workspaceNotFound(workspace);
  return row;
});

const loadRegistrationChange = Effect.fn("WorkspaceRegistry.loadRegistrationChange")(function* (
  services: WorkspaceLoadingServices,
  row: WorkspaceRow,
  authoringRoots: AuthoringRoots,
) {
  return yield* loadWorkspaceInput(services, row).pipe(
    Effect.flatMap((input) =>
      loadWorkspace(services, row, authoringRoots, input).pipe(
        Effect.map((workspace) => ({ _tag: "Registered" as const, workspace })),
        Effect.catchTag("WorkspaceRegistrationError", (error) =>
          Effect.succeed({
            _tag: "Failed" as const,
            failure: workspaceFailure(row, error.message, input.repository),
          }),
        ),
      ),
    ),
    Effect.catchTag("WorkspaceRegistrationError", (error) =>
      Effect.succeed({
        _tag: "Failed" as const,
        failure: workspaceFailure(row, error.message, present(row.lastRepository) ?? legacyRepository(row)),
      }),
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
    loadRegistrationChange(services, row, authoringRoots),
  );
  const workspaces = outcomes.flatMap((outcome) =>
    outcome._tag === "Registered" ? [outcome.workspace] : [],
  );
  const failures = outcomes.flatMap((outcome) => (outcome._tag === "Failed" ? [outcome.failure] : []));
  return { workspaces, failures } satisfies RegistryState;
});

const insertWorkspace = Effect.fn("WorkspaceRegistry.insertWorkspace")(function* (
  sql: SqlClient.SqlClient,
  id: WorkspaceId,
  registration: WorkspaceRegistration,
) {
  const worktrees = registration.worktrees;
  const [row] = yield* sql<WorkspaceRow>`INSERT INTO workspaces (
    id, name, checkout_path, issue_tracker, source_control, mcp_skills, linear_history,
    worktree_root, worktree_remote, worktree_base_branch, worktree_link_paths, worktree_setup,
    worktree_reap_after_millis, concurrency
  ) VALUES (
    ${id},
    ${registration.name},
    ${registration.checkoutPath},
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
    last_repository AS lastRepository,
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

const persistRepository = Effect.fn("WorkspaceRegistry.persistRepository")(function* (
  sql: SqlClient.SqlClient,
  workspaceId: WorkspaceId,
  repository: string | undefined,
) {
  yield* sql`UPDATE workspaces
    SET last_repository = ${repository ?? null}
    WHERE id = ${workspaceId}`;
});

const persistWorkspaceRepository = (sql: SqlClient.SqlClient, workspace: RegisteredWorkspace) =>
  persistRepository(sql, workspace.config.name, workspace.repository);

const persistFailureRepository = (sql: SqlClient.SqlClient, failure: RegisteredWorkspaceFailure) => {
  if (!failure.name || !failure.repository) return Effect.void;
  return persistRepository(sql, failure.name, failure.repository);
};

const persistRegistrationRepository = Effect.fn("WorkspaceRegistry.persistRegistrationRepository")(function* (
  sql: SqlClient.SqlClient,
  change: WorkspaceRegistrationChange,
) {
  yield* change._tag === "Failed"
    ? persistFailureRepository(sql, change.failure)
    : persistWorkspaceRepository(sql, change.workspace);
  return change;
});

const persistStateRepositories = Effect.fn("WorkspaceRegistry.persistStateRepositories")(function* (
  sql: SqlClient.SqlClient,
  state: RegistryState,
) {
  yield* Effect.forEach(state.workspaces, (workspace) => persistWorkspaceRepository(sql, workspace), {
    discard: true,
  });
  yield* Effect.forEach(state.failures, (failure) => persistFailureRepository(sql, failure), {
    discard: true,
  });
});

const withoutWorkspace = (state: RegistryState, name: WorkspaceId | undefined) => {
  if (!name) return state;
  return {
    workspaces: state.workspaces.filter((workspace) => workspace.config.name !== name),
    failures: state.failures.filter((failure) => failure.name !== name),
  };
};

const withPreviousRepository = (state: RegistryState, failure: RegisteredWorkspaceFailure) => {
  if (failure.repository || !failure.name) return failure;
  const repository = findWorkspaceIssueTrackerBinding(state, failure.name)?.repository;
  if (!repository) return failure;
  return { ...failure, repository };
};

const withPreviousRepositories = (previous: RegistryState, next: RegistryState) => ({
  ...next,
  failures: next.failures.map((failure) => withPreviousRepository(previous, failure)),
});

const foldRegistration = (state: RegistryState, change: WorkspaceRegistrationChange) => {
  if (change._tag === "Registered") {
    const current = withoutWorkspace(state, change.workspace.config.name);
    return { ...current, workspaces: [...current.workspaces, change.workspace] };
  }
  const failure = withPreviousRepository(state, change.failure);
  const current = withoutWorkspace(state, failure.name);
  return { ...current, failures: [...current.failures, failure] };
};

export const layer = (controlStorePath: string, userAgentsDir: string) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const random = yield* SecureRandom.SecureRandom;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* Git;
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ControlStore;
      const managementGate = Semaphore.makeUnsafe(1);
      const cogworkHome = path.dirname(controlStorePath);
      const authoringRoots = { cogworkHome, userAgentsDir };
      const privateWorkspaceRoot = path.join(cogworkHome, "workspaces");
      const loadingServices = {
        fileSystem: fs,
        path,
        remoteUrl: git.remoteUrl,
        scanAuthoringTrees: (request: ScanAuthoringTreesRequest) =>
          scanAuthoringTrees(request).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          ),
      } satisfies WorkspaceLoadingServices;
      const ensureWritableStore = Effect.fn("WorkspaceManagement.ensureWritableStore")(function* (
        workspace: WorkspaceId,
        operation: string,
      ) {
        if (store.health !== "unavailable") return;
        return yield* workspaceManagementFailure(workspace, operation, store.message);
      });
      const loadState = Effect.fn("WorkspaceRegistry.loadState")(function* () {
        if (store.health === "unavailable") return emptyRegistry;
        return yield* loadAvailableState(sql, loadingServices, authoringRoots);
      });
      const initial = yield* loadState();
      yield* store.withWrite(persistStateRepositories(sql, initial));
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
      const commitRefresh = Effect.fn("WorkspaceRegistry.commitRefresh")(function* (
        expectedRevision: number,
        state: RegistryState,
      ) {
        const current = yield* Ref.get(cell);
        if (current.revision !== expectedRevision) return current.state;
        const next = withPreviousRepositories(current.state, state);
        yield* persistStateRepositories(sql, next);
        yield* Ref.set(cell, { state: next, revision: current.revision + 1 });
        return next;
      });
      const registry: WorkspaceRegistryService = {
        state: Ref.get(cell).pipe(Effect.map((current) => current.state)),
        refresh: Ref.get(cell).pipe(
          Effect.flatMap(({ revision }) =>
            loadState().pipe(
              Effect.flatMap((state) => store.withWrite(commitRefresh(revision, state))),
              Effect.mapError((error) => registrationError(error)),
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
        const row = yield* store.withWrite(
          selectWorkspaceBinding(sql, normalizedRegistration.checkoutPath).pipe(
            Effect.mapError((error) => registrationError(error)),
            Effect.flatMap((existing) => {
              if (existing) {
                return registrationError(`Workspace checkout path is already registered as ${existing.id}`);
              }
              return random.uuidV7().pipe(
                Effect.flatMap(decodeWorkspaceId),
                Effect.mapError((error) => registrationError(error)),
              );
            }),
            Effect.flatMap((id) =>
              insertWorkspace(sql, id, normalizedRegistration).pipe(
                Effect.mapError((error) => registrationError(error)),
              ),
            ),
          ),
        );
        const change = yield* loadRegistrationChange(loadingServices, row, authoringRoots);
        return yield* store.withWrite(
          persistRegistrationRepository(sql, change).pipe(
            Effect.flatMap(commitChange),
            Effect.mapError((error) => registrationError(error)),
          ),
        );
      });
      const rebind = Effect.fn("WorkspaceManagement.rebind")(function* (
        workspace: WorkspaceId,
        checkoutPath: string,
      ) {
        yield* ensureWritableStore(workspace, "re-bind workspace");
        if (!path.isAbsolute(checkoutPath)) {
          return yield* workspaceManagementFailure(
            workspace,
            "re-bind workspace",
            "Workspace checkout path must be absolute",
          );
        }
        const normalizedPath = path.resolve(checkoutPath);
        const row = yield* store
          .withWrite(rebindWorkspaceRow(sql, workspace, normalizedPath))
          .pipe(Effect.mapError(managementError(workspace, "re-bind workspace")));
        const change = yield* loadRegistrationChange(loadingServices, row, authoringRoots);
        return yield* store.withWrite(
          persistRegistrationRepository(sql, change).pipe(
            Effect.flatMap(commitChange),
            Effect.mapError(managementError(workspace, "re-bind workspace")),
          ),
        );
      });
      const update = Effect.fn("WorkspaceManagement.update")(function* (
        workspace: WorkspaceId,
        workspaceUpdate: WorkspaceUpdate,
      ) {
        yield* ensureWritableStore(workspace, "update workspace");
        const row = yield* store
          .withWrite(sql.withTransaction(updateWorkspaceRow(sql, workspace, workspaceUpdate)))
          .pipe(Effect.mapError(managementError(workspace, "update workspace")));
        const change = yield* loadRegistrationChange(loadingServices, row, authoringRoots);
        return yield* store.withWrite(
          persistRegistrationRepository(sql, change).pipe(
            Effect.flatMap(commitChange),
            Effect.mapError(managementError(workspace, "update workspace")),
          ),
        );
      });
      const deregisterStoredWorkspace = Effect.fn("WorkspaceManagement.deregisterStoredWorkspace")(function* (
        workspace: WorkspaceId,
      ) {
        const row = yield* selectWorkspaceRow(sql, workspace);
        if (!row) return yield* workspaceNotFound(workspace);
        yield* sql.withTransaction(
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
        );
        return yield* commitRemoval(workspace);
      });
      const deregister = Effect.fn("WorkspaceManagement.deregister")(function* (workspace: WorkspaceId) {
        yield* ensureWritableStore(workspace, "deregister workspace");
        return yield* store
          .withWrite(deregisterStoredWorkspace(workspace))
          .pipe(Effect.mapError(managementError(workspace, "deregister workspace")));
      });
      return Context.make(WorkspaceRegistry, registry).pipe(
        Context.add(WorkspaceManagement, {
          register: (registration) => managementGate.withPermits(1)(register(registration)),
          update: (workspace, workspaceUpdate) =>
            managementGate.withPermits(1)(update(workspace, workspaceUpdate)),
          deregister: (workspace) => managementGate.withPermits(1)(deregister(workspace)),
          rebind: (workspace, checkoutPath) => managementGate.withPermits(1)(rebind(workspace, checkoutPath)),
        }),
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
      const git = yield* Git;
      const sql = yield* SqlClient.SqlClient;
      const loadingServices = {
        fileSystem: fs,
        path,
        remoteUrl: git.remoteUrl,
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
