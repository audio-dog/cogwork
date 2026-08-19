import { linearTeams, type WorkspaceConfig } from "@cogwork/contracts";
import type { CredentialAccount } from "../credential-store";

// Several teams share one token, so a multi-team key can't be any single team key; it falls back to
// the workspace name.
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
