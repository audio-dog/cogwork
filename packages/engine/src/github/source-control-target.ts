import type { ConnectionBindingId, ConnectionId, PrBaseDivergence } from "@cogwork/contracts";

import type { WorkspaceIssueTrackerBinding } from "../projector";
import { type GitHubRepoRef, repoRefFromRepository } from "./client";

export interface BotWakeMode {
  readonly acceptsAnyComment: boolean;
}

export type BotAllowlist = ReadonlyMap<string, BotWakeMode>;

export interface GitHubTargetConfig extends GitHubRepoRef {
  readonly botAllowlist: BotAllowlist;
}

const botAllowlistEntry = (entry: string): readonly [string, BotWakeMode] => {
  const acceptsAnyComment = entry.endsWith(":any");
  const login = acceptsAnyComment ? entry.slice(0, -4) : entry;
  return [login, { acceptsAnyComment }];
};

export const botAllowlistFrom = (entries: ReadonlyArray<string>) => new Map(entries.map(botAllowlistEntry));

const targetFromRepo = (
  repo: string,
  connectionId: ConnectionBindingId,
  botAllowlist: ReadonlyArray<string> | undefined,
): GitHubTargetConfig | null => {
  const repository = repoRefFromRepository(repo);
  if (!repository) return null;
  const boundConnectionId: ConnectionId | undefined = connectionId === "unbound" ? undefined : connectionId;
  return {
    ...repository,
    ...(boundConnectionId ? { connectionId: boundConnectionId } : {}),
    botAllowlist: botAllowlistFrom(botAllowlist ?? []),
  };
};

export const sourceControlTargetFor = (
  workspace: WorkspaceIssueTrackerBinding,
): GitHubTargetConfig | null => {
  const explicit = workspace.config.sourceControl;
  if (explicit) {
    if (explicit.type !== "github" || !workspace.repository) return null;
    return targetFromRepo(workspace.repository, explicit.connectionId, explicit.botAllowlist);
  }
  const source = workspace.config.issueTracker;
  if (source.type !== "github" || !workspace.repository) return null;
  return targetFromRepo(workspace.repository, source.connectionId, source.botAllowlist);
};

export const baseDivergenceOf = (mergeableState: string | null): PrBaseDivergence => {
  if (mergeableState === "dirty") return "conflict";
  if (mergeableState === "behind") return "clean";
  return "none";
};
