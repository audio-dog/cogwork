import { WorkspaceRegistration, WorkspaceState } from "@cogwork/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type WorkspaceTracker = "github" | "linear";

export interface WorkspaceRegistrationDraft {
  readonly name: string;
  readonly checkoutPath: string;
  readonly gitRemote: string;
  readonly tracker: WorkspaceTracker;
  readonly issueTrackerConnectionId: string;
  readonly repository: string;
  readonly linearTeams: string;
  readonly linearOrganization: string;
  readonly sourceControlRepository: string;
  readonly sourceControlConnectionId: string;
}

interface WorkspaceSubmission {
  readonly submitted: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly outcomeError: string | null;
  readonly outcome: unknown | null;
}

const decodeWorkspaceRegistration = Schema.decodeUnknownOption(WorkspaceRegistration);
const trimmed = (value: string) => value.trim();
const optional = (value: string) => trimmed(value) || undefined;
const teamsFrom = (value: string) => [...new Set(value.split(",").map(trimmed).filter(Boolean))];
const githubSourceControlFrom = (repository: string | undefined, connectionId: string | undefined) => {
  if (!repository) return undefined;
  if (!connectionId) return null;
  return { type: "github", connectionId, repo: repository };
};

export const absoluteCheckoutPathFrom = (value: string) => {
  const path = trimmed(value);
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path) ? path : null;
};

export const workspaceSubmissionStatus = ({
  submitted,
  pending,
  error,
  outcomeError,
  outcome,
}: WorkspaceSubmission) => {
  if (!submitted) return "idle";
  if (pending) return "submitting";
  if (error || outcomeError) return "failed";
  if (outcome !== null) return "complete";
  return "submitting";
};

export const workspaceSubmissionIsLocked = (status: ReturnType<typeof workspaceSubmissionStatus>) =>
  status === "submitting" || status === "complete";

export const workspaceOutcomeError = (outcome: WorkspaceState | null) => {
  if (!WorkspaceState.guards.Failed(outcome)) return null;
  return outcome.message;
};

const registrationInputFrom = (draft: WorkspaceRegistrationDraft) => {
  const name = trimmed(draft.name);
  const checkoutPath = absoluteCheckoutPathFrom(draft.checkoutPath);
  if (!checkoutPath) return null;

  const gitRemote = optional(draft.gitRemote);
  const repository = trimmed(draft.repository);
  const issueTrackerConnectionId = trimmed(draft.issueTrackerConnectionId);
  if (!issueTrackerConnectionId) return null;
  if (draft.tracker === "github" && !repository) return null;
  const registration = {
    name,
    checkoutPath,
    ...(gitRemote ? { gitRemote } : {}),
    linearHistory: false,
  };
  if (draft.tracker === "github") {
    return {
      ...registration,
      issueTracker: { type: "github", connectionId: issueTrackerConnectionId, repo: repository },
    };
  }

  const teams = teamsFrom(draft.linearTeams);
  if (teams.length === 0) return null;
  const organization = optional(draft.linearOrganization);
  const sourceControl = githubSourceControlFrom(
    optional(draft.sourceControlRepository),
    optional(draft.sourceControlConnectionId),
  );
  if (sourceControl === null) return null;
  return {
    ...registration,
    issueTracker: {
      type: "linear",
      connectionId: issueTrackerConnectionId,
      teams,
      ...(organization ? { organization } : {}),
    },
    ...(sourceControl ? { sourceControl } : {}),
  };
};

export const workspaceRegistrationFrom = (draft: WorkspaceRegistrationDraft) => {
  const input = registrationInputFrom(draft);
  if (!input) return null;
  return Option.getOrNull(decodeWorkspaceRegistration(input));
};
