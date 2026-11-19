import { connectionAccountOf, linearTeams, type WorkspaceConfig } from "@cogwork/contracts";
import type { CredentialAccount } from "../credential-store";

type LinearWorkspaceConfig = Pick<WorkspaceConfig, "id" | "issueTracker">;

// Several teams share one token, so a multi-team key can't be any single team key; it falls back to
// the workspace id.
const linearAccountKey = (config: LinearWorkspaceConfig): string | null => {
  const [first, ...rest] = linearTeams(config.issueTracker);
  if (first === undefined) return null;
  return rest.length === 0 ? first : config.id;
};

export const credentialAccountFor = (config: LinearWorkspaceConfig): CredentialAccount | null => {
  const key = linearAccountKey(config);
  if (key === null) return null;
  const source = config.issueTracker;
  const connectionId = source.connectionId === "unbound" ? undefined : source.connectionId;
  const account = connectionId ? connectionAccountOf(connectionId) : null;
  return {
    ...(connectionId ? { connectionId } : {}),
    key,
    issueTracker: "linear",
    organization: account === "default" ? null : account,
    tokenEnv: "LINEAR_API_KEY",
    clientCredentials: null,
    oauthClientId: null,
  };
};
