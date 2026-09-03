import { type WorkspaceId, WorkspaceState } from "@cogwork/contracts";

/** The columns this page can read back and write. #457 restores the rest with its act. */
export interface WorkspaceRecordDraft {
  readonly displayName: string;
  readonly checkoutPath: string;
}

export const emptyDraft: WorkspaceRecordDraft = { displayName: "", checkoutPath: "" };

/** How many top-level draft keys differ. The save bar counts them. */
export const changedFieldCount = (draft: WorkspaceRecordDraft, against: WorkspaceRecordDraft) =>
  (Object.keys(draft) as ReadonlyArray<keyof WorkspaceRecordDraft>).filter(
    (key) => JSON.stringify(draft[key]) !== JSON.stringify(against[key]),
  ).length;

export const seededDraft = (workspace: WorkspaceState): WorkspaceRecordDraft =>
  WorkspaceState.match(workspace, {
    Registered: ({ displayName, name, checkoutPath }) => ({ displayName: displayName ?? name, checkoutPath }),
    Failed: () => emptyDraft,
  });

/** The id an act can target. A Failed workspace input may never have been minted one. */
export const workspaceIdentity = (workspace: WorkspaceState) =>
  WorkspaceState.match<WorkspaceId | null>(workspace, {
    Registered: ({ name }) => name,
    Failed: ({ name }) => name ?? null,
  });

export const workspaceKey = (workspace: WorkspaceState) =>
  WorkspaceState.match(workspace, {
    Registered: ({ name }) => name,
    Failed: ({ name, source }) => name ?? source,
  });

export const workspaceLabel = (workspace: WorkspaceState) =>
  WorkspaceState.match(workspace, {
    Registered: ({ displayName, name }) => displayName ?? name,
    Failed: ({ displayName, name, source }) => displayName ?? name ?? source,
  });

export interface WorkspaceHealth {
  readonly tone: "ok" | "pending" | "paused" | "failed";
  readonly label: string;
  readonly detail: string;
}

export const workspaceHealth = (workspace: WorkspaceState, dangling: boolean): WorkspaceHealth => {
  if (WorkspaceState.guards.Failed(workspace)) {
    return { tone: "failed", label: "Workspace input failed", detail: workspace.message };
  }
  if (dangling) {
    return {
      tone: "failed",
      label: "Connection removed",
      detail: "Establish it again on Connections to start polling.",
    };
  }
  if (workspace.poll.status === "paused") {
    return {
      tone: "paused",
      label: `Polling paused · ${workspace.poll.reason}`,
      detail: workspace.poll.message,
    };
  }
  if (workspace.poll.status === "pending") {
    return {
      tone: "pending",
      label: "Waiting for the first poll",
      detail: "The reconcile worker has not answered yet.",
    };
  }
  const blocked = workspace.availability.filter((entry) => !entry.available);
  if (blocked.length > 0) {
    return {
      tone: "pending",
      label: `${blocked.length} operation${blocked.length === 1 ? "" : "s"} cannot run`,
      detail: blocked
        .map((entry) => `${entry.operation}: ${entry.causes.map((cause) => cause.message).join(", ")}`)
        .join(" · "),
    };
  }
  return { tone: "ok", label: "Polling", detail: "The reconcile worker is reading this workspace." };
};
