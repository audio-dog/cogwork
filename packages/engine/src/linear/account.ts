import { connectionAccountOf, linearTeams, type WorkspaceConfig } from "@cogwork/contracts";
import type { CredentialAccount } from "../credential-store";

type LinearWorkspaceConfig = Pick<WorkspaceConfig, "name" | "issueTracker">;

// Several teams share one token, so a multi-team key can't be any single team key; it falls back to
// the workspace name.
const linearAccountKey = (config: LinearWorkspaceConfig): string | null => {
  const [first, ...rest] = linearTeams(config.issueTracker);
  if (first === undefined) return null;
  return rest.length === 0 ? first : config.name;
};

export const credentialAccountFor = (config: LinearWorkspaceConfig): CredentialAccount | null => {
  const key = linearAccountKey(config);
  if (key === null) return null;
  const source = config.issueTracker;
  const account = connectionAccountOf(source.connectionId);
  return {
    connectionId: source.connectionId,
    key,
    issueTracker: "linear",
    organization: account === "default" || source.connectionId === "unbound" ? null : account,
    tokenEnv: "LINEAR_API_KEY",
    clientCredentials: null,
    oauthClientId: null,
  };
};
