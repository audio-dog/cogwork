import { linearTeams, type WorkspaceConfig } from "@cogwork/contracts";
import type { CredentialAccount } from "../credential-store";

// The credential-store key for a workspace's Linear token. One team keeps using that team key, so
// existing single-team workspaces don't have to log in again. Several teams share one token, so the
// key falls back to the workspace name — a stable handle that doesn't favor any one team.
const linearAccountKey = (config: WorkspaceConfig): string | null => {
  const [first, ...rest] = linearTeams(config.issueTracker);
  if (first === undefined) return null;
  return rest.length === 0 ? first : config.name;
};

export const credentialAccountFor = (config: WorkspaceConfig): CredentialAccount | null => {
  const key = linearAccountKey(config);
  if (key === null) return null;
  const source = config.issueTracker;
  const oauth = source.oauth;
  return {
    key,
    issueTracker: "linear",
    organization: source.organization ?? null,
    tokenEnv: source.tokenEnv ?? "LINEAR_API_KEY",
    clientCredentials:
      oauth?.clientSecretEnv != null ? { clientId: oauth.clientId, secretEnv: oauth.clientSecretEnv } : null,
    oauthClientId: oauth?.clientId ?? null,
  };
};
