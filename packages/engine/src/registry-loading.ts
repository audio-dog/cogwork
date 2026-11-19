import {
  type IssueTrackerConfig,
  type SourceControlConfig,
  type WorkspaceId,
  WorkspaceRegistrationError,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ScanAuthoringTreesRequest, scanAuthoringTrees } from "./authoring-tree";
import type { GitError } from "./git";
import type { RegisteredWorkspace, RegisteredWorkspaceFailure, RegistryState } from "./projector";
import { messageOf, registrationError } from "./registry-errors";
import {
  decodeIssueTracker,
  decodeIssueTrackerOption,
  decodeLegacyGitHubRepositoryOption,
  decodeSourceControl,
  decodeSourceControlOption,
  decodeWorkspaceBindingColumns,
  decodeWorkspaceConfig,
  decodeWorkspaceId,
  decodeWorkspaceIdOption,
  decodeWorkspaceRegistration,
  selectRows,
  type WorkspaceBindingColumns,
  type WorkspaceRow,
} from "./registry-rows";

export interface AuthoringRoots {
  readonly cogworkHome: string;
  readonly userAgentsDir?: string;
}

type AuthoringTreeScanner = (
  request: ScanAuthoringTreesRequest,
) => Effect.Effect<
  Effect.Success<ReturnType<typeof scanAuthoringTrees>>,
  Effect.Error<ReturnType<typeof scanAuthoringTrees>>
>;

export interface WorkspaceLoadingServices {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly remoteUrl: (checkoutPath: string, remote: string) => Effect.Effect<string, GitError>;
  readonly scanAuthoringTrees: AuthoringTreeScanner;
}

interface LoadedWorkspaceInput {
  readonly id: WorkspaceId;
  readonly issueTracker: IssueTrackerConfig;
  readonly sourceControl?: SourceControlConfig;
  readonly repository?: string;
}

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
  const id = Option.getOrUndefined(decodeWorkspaceIdOption(row.id));
  const issueTracker = Option.getOrUndefined(decodeIssueTrackerOption(row.issueTracker));
  const sourceControl = Option.getOrUndefined(decodeSourceControlOption(row.sourceControl));
  return {
    ...(id ? { id } : {}),
    ...(issueTracker ? { issueTracker } : {}),
    ...(sourceControl ? { sourceControl } : {}),
    ...(repository ? { repository } : {}),
    displayName: row.name,
    source: row.checkoutPath,
    message,
    workspaceLimit: present(row.concurrency),
  } satisfies RegisteredWorkspaceFailure;
};

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
  const id = yield* decodeWorkspaceId(row.id).pipe(Effect.mapError((error) => registrationError(error)));
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
  return { id, issueTracker, sourceControl, repository } satisfies LoadedWorkspaceInput;
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
    displayName: row.name,
    checkoutPath: row.checkoutPath,
    issueTracker: input.issueTracker,
    sourceControl: input.sourceControl,
    mcpSkills: present(binding.mcpSkills),
    worktrees: worktreesFrom(row, binding),
    linearHistory: row.linearHistory === 1,
    concurrency: present(row.concurrency),
  }).pipe(Effect.mapError((error) => registrationError(error)));
  const config = yield* decodeWorkspaceConfig({
    id: input.id,
    displayName: record.displayName,
    checkoutPath: record.checkoutPath,
    issueTracker: record.issueTracker,
    sourceControl: record.sourceControl,
    mcpSkills: record.mcpSkills,
    worktrees: record.worktrees,
    linearHistory: record.linearHistory,
  }).pipe(Effect.mapError((error) => registrationError(error)));
  const contributions = yield* services
    .scanAuthoringTrees({
      workspace: input.id,
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

export const loadRegistrationChange = Effect.fn("WorkspaceRegistry.loadRegistrationChange")(function* (
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

export const loadAvailableState = Effect.fn("WorkspaceRegistry.loadAvailableState")(function* (
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
