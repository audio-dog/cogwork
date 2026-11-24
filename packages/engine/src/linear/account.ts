import {
  type ConnectionBindingId,
  connectionAccountOf,
  linearTeams,
  type WorkspaceConfig,
} from "@cogwork/contracts";

import type { CredentialAccount } from "../credential-store";

type LinearWorkspaceConfig = Pick<WorkspaceConfig, "id" | "issueTracker">;

// Several teams share one token, so a multi-team key can't be any single team key; it falls back to
// the workspace id.
const linearAccountKey = (config: LinearWorkspaceConfig): string | null => {
  const [first, ...rest] = linearTeams(config.issueTracker);
  if (first === undefined) return null;
  return rest.length === 0 ? first : config.id;
};

export const connectionCredentialAccount = (key: string, connectionId: ConnectionBindingId) => {
  const bound = connectionId === "unbound" ? undefined : connectionId;
  const account = bound ? connectionAccountOf(bound) : null;
  return {
    ...(bound ? { connectionId: bound } : {}),
    key,
    issueTracker: "linear",
    organization: account === "default" ? null : account,
    tokenEnv: "LINEAR_API_KEY",
    clientCredentials: null,
    oauthClientId: null,
  } satisfies CredentialAccount;
};

export const credentialAccountFor = (config: LinearWorkspaceConfig): CredentialAccount | null => {
  const key = linearAccountKey(config);
  if (key === null) return null;
  return connectionCredentialAccount(key, config.issueTracker.connectionId);
};
