import type { WorkspaceConfig } from "@clanker-forge/contracts";
import type { CredentialAccount } from "../credential-store";

export const credentialAccountFor = (config: WorkspaceConfig): CredentialAccount | null => {
  const source = config.issueTracker;
  if (source.type !== "linear" || !source.team) return null;
  const oauth = source.oauth;
  return {
    key: source.team,
    issueTracker: "linear",
    organization: source.organization ?? null,
    tokenEnv: source.tokenEnv ?? "LINEAR_API_KEY",
    clientCredentials:
      oauth?.clientSecretEnv != null ? { clientId: oauth.clientId, secretEnv: oauth.clientSecretEnv } : null,
    oauthClientId: oauth?.clientId ?? null,
  };
};
