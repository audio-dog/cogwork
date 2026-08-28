import { WorkspaceRegistration } from "@cogwork/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type WorkspaceTracker = "github" | "linear";

export interface WorkspaceRegistrationDraft {
  readonly name: string;
  readonly checkoutPath: string;
  readonly gitRemote: string;
  readonly tracker: WorkspaceTracker;
  readonly repository: string;
  readonly linearTeams: string;
  readonly linearOrganization: string;
  readonly sourceControlRepository: string;
}

const trimmed = (value: string) => value.trim();
const optional = (value: string) => trimmed(value) || undefined;
const teamsFrom = (value: string) => [...new Set(value.split(",").map(trimmed).filter(Boolean))];

export const absoluteCheckoutPathFrom = (value: string) => {
  const path = trimmed(value);
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path) ? path : null;
};

const registrationInputFrom = (draft: WorkspaceRegistrationDraft) => {
  const name = trimmed(draft.name);
  const checkoutPath = absoluteCheckoutPathFrom(draft.checkoutPath);
  if (!checkoutPath) return null;

  const gitRemote = optional(draft.gitRemote);
  const repository = trimmed(draft.repository);
  if (draft.tracker === "github" && !repository) return null;
  if (draft.tracker === "github") {
    return {
      name,
      checkoutPath,
      ...(gitRemote ? { gitRemote } : {}),
      issueTracker: { type: "github", repo: repository },
      linearHistory: false,
    };
  }

  const teams = teamsFrom(draft.linearTeams);
  if (teams.length === 0) return null;
  const organization = optional(draft.linearOrganization);
  const sourceControlRepository = optional(draft.sourceControlRepository);
  return {
    name,
    checkoutPath,
    ...(gitRemote ? { gitRemote } : {}),
    issueTracker: {
      type: "linear",
      teams,
      ...(organization ? { organization } : {}),
    },
    ...(sourceControlRepository ? { sourceControl: { type: "github", repo: sourceControlRepository } } : {}),
    linearHistory: false,
  };
};

export const workspaceRegistrationFrom = (draft: WorkspaceRegistrationDraft) => {
  const input = registrationInputFrom(draft);
  if (!input) return null;
  return Option.getOrNull(Schema.decodeUnknownOption(WorkspaceRegistration)(input));
};
