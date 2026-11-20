import {
  IssueTrackerConfig,
  McpSkill,
  SourceControlConfig,
  TrimmedNonEmptyString,
  WorkspaceConfig,
  WorkspaceId,
  WorkspaceRecord,
  type WorkspaceRegistration,
  type WorkspaceUpdate,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { RegisteredWorkspace, RegisteredWorkspaceFailure, RegistryState } from "./projector";
import { registrationError, workspaceManagementFailure, workspaceNotFound } from "./registry-errors";
import type { WorkspaceRegistrationChange } from "./registry-management";

export interface WorkspaceRow {
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
export const WorkspaceBindingColumns = Schema.Struct({
  mcpSkills: Schema.NullOr(Schema.fromJsonString(McpSkills)),
  worktreeLinkPaths: Schema.NullOr(Schema.fromJsonString(WorktreeValues)),
  worktreeSetup: Schema.NullOr(Schema.fromJsonString(WorktreeValues)),
});
export const decodeWorkspaceId = Schema.decodeUnknownEffect(WorkspaceId);
export const decodeWorkspaceIdOption = Schema.decodeUnknownOption(WorkspaceId);
export const decodeIssueTracker = Schema.decodeUnknownEffect(Schema.fromJsonString(IssueTrackerConfig));
export const decodeIssueTrackerOption = Schema.decodeUnknownOption(Schema.fromJsonString(IssueTrackerConfig));
export const decodeSourceControl = Schema.decodeUnknownEffect(Schema.fromJsonString(SourceControlConfig));
export const decodeSourceControlOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(SourceControlConfig),
);
export const decodeLegacyGitHubRepositoryOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(LegacyGitHubRepository),
);
export const decodeWorkspaceBindingColumns = Schema.decodeUnknownEffect(WorkspaceBindingColumns);
export const decodeWorkspaceConfig = Schema.decodeUnknownEffect(WorkspaceConfig);
export const decodeWorkspaceRecord = Schema.decodeUnknownEffect(WorkspaceRecord);
const encodeIssueTracker = Schema.encodeSync(Schema.fromJsonString(IssueTrackerConfig));
const encodeSourceControl = Schema.encodeSync(Schema.fromJsonString(SourceControlConfig));
const encodeMcpSkills = Schema.encodeSync(Schema.fromJsonString(McpSkills));
const encodeWorktreeValues = Schema.encodeSync(Schema.fromJsonString(WorktreeValues));

export const selectRows = Effect.fn("WorkspaceRegistry.selectRows")(function* (sql: SqlClient.SqlClient) {
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

export const selectWorkspaceBinding = Effect.fn("WorkspaceRegistry.selectWorkspaceBinding")(function* (
  sql: SqlClient.SqlClient,
  checkoutPath: string,
) {
  const [row] = yield* sql<WorkspaceIdentityRow>`SELECT id
    FROM workspaces
    WHERE checkout_path = ${checkoutPath}
    LIMIT 1`;
  return row;
});

export const selectWorkspaceRow = Effect.fn("WorkspaceRegistry.selectWorkspaceRow")(function* (
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

export const rebindWorkspaceRow = Effect.fn("WorkspaceRegistry.rebindWorkspaceRow")(function* (
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

export const updateWorkspaceRow = Effect.fn("WorkspaceRegistry.updateWorkspaceRow")(function* (
  sql: SqlClient.SqlClient,
  workspace: WorkspaceId,
  update: WorkspaceUpdate,
) {
  const worktrees = update.worktrees;
  const [row] = yield* sql<WorkspaceRow>`UPDATE workspaces SET
    name = ${update.displayName},
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

export const insertWorkspace = Effect.fn("WorkspaceRegistry.insertWorkspace")(function* (
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
    ${registration.displayName},
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
  persistRepository(sql, workspace.config.id, workspace.repository);

const persistFailureRepository = (sql: SqlClient.SqlClient, failure: RegisteredWorkspaceFailure) => {
  if (!failure.id || !failure.repository) return Effect.void;
  return persistRepository(sql, failure.id, failure.repository);
};

export const persistRegistrationRepository = Effect.fn("WorkspaceRegistry.persistRegistrationRepository")(
  function* (sql: SqlClient.SqlClient, change: WorkspaceRegistrationChange) {
    yield* change._tag === "Failed"
      ? persistFailureRepository(sql, change.failure)
      : persistWorkspaceRepository(sql, change.workspace);
    return change;
  },
);

export const persistStateRepositories = Effect.fn("WorkspaceRegistry.persistStateRepositories")(function* (
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
