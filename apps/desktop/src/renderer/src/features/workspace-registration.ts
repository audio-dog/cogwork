import { WorkspaceRegistration } from "@cogwork/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type WorkspaceTracker = "github" | "linear";

export interface WorkspaceRegistrationDraft {
  readonly checkoutPath: string;
  readonly tracker: WorkspaceTracker;
  readonly issueTrackerConnectionId: string;
  readonly linearTeams: string;
  readonly linearOrganization: string;
  readonly sourceControlConnectionId: string;
}

const decodeWorkspaceRegistration = Schema.decodeUnknownOption(WorkspaceRegistration);
const trimmed = (value: string) => value.trim();
const optional = (value: string) => trimmed(value) || undefined;
const teamsFrom = (value: string) => [...new Set(value.split(",").map(trimmed).filter(Boolean))];
const githubSourceControlFrom = (connectionId: string | undefined) =>
  connectionId ? { type: "github" as const, connectionId } : undefined;

export const absoluteCheckoutPathFrom = (value: string) => {
  const path = trimmed(value);
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path) ? path : null;
};

const workspaceNameFrom = (checkoutPath: string) => checkoutPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "";

const registrationInputFrom = (draft: WorkspaceRegistrationDraft) => {
  const checkoutPath = absoluteCheckoutPathFrom(draft.checkoutPath);
  if (!checkoutPath) return null;

  const issueTrackerConnectionId = trimmed(draft.issueTrackerConnectionId);
  if (!issueTrackerConnectionId) return null;
  const registration = {
    displayName: workspaceNameFrom(checkoutPath),
    checkoutPath,
    linearHistory: false,
  };
  if (draft.tracker === "github") {
    return {
      ...registration,
      issueTracker: { type: "github", connectionId: issueTrackerConnectionId },
    };
  }

  const teams = teamsFrom(draft.linearTeams);
  if (teams.length === 0) return null;
  const organization = optional(draft.linearOrganization);
  const sourceControl = githubSourceControlFrom(optional(draft.sourceControlConnectionId));
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
