import type { WorkspaceState } from "@cogwork/contracts";

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
  workspace._tag === "Failed"
    ? emptyDraft
    : { displayName: workspace.displayName ?? workspace.name, checkoutPath: workspace.checkoutPath };

export const workspaceKey = (workspace: WorkspaceState) =>
  workspace._tag === "Registered" ? workspace.name : (workspace.name ?? workspace.source);

export const workspaceLabel = (workspace: WorkspaceState) =>
  workspace._tag === "Registered"
    ? (workspace.displayName ?? workspace.name)
    : (workspace.displayName ?? workspace.name ?? workspace.source);

export interface WorkspaceHealth {
  readonly tone: "ok" | "pending" | "paused" | "failed";
  readonly label: string;
  readonly detail: string;
}

export const workspaceHealth = (workspace: WorkspaceState, dangling: boolean): WorkspaceHealth => {
  if (workspace._tag === "Failed") {
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
