import type { Connection, WorkspaceId } from "@cogwork/contracts";
import { createContext, type ReactNode, use } from "react";

import type { WorkspaceRecordDraft } from "../features/workspace-record";

export type PatchDraft = (next: Partial<WorkspaceRecordDraft>) => void;

export interface WorkspaceRecordValue {
  readonly state: { readonly draft: WorkspaceRecordDraft; readonly connections: readonly Connection[] };
  readonly actions: { readonly patch: PatchDraft };
  readonly meta: { readonly disabled: boolean; readonly workspace: WorkspaceId | null };
}

const WorkspaceRecordContext = createContext<WorkspaceRecordValue | null>(null);

export function useWorkspaceRecord() {
  const value = use(WorkspaceRecordContext);
  if (!value) throw new Error("Workspace record rows must render inside a WorkspaceRecord.Provider");
  return value;
}

export function WorkspaceRecordProvider({
  value,
  children,
}: {
  readonly value: WorkspaceRecordValue;
  readonly children: ReactNode;
}) {
  return <WorkspaceRecordContext value={value}>{children}</WorkspaceRecordContext>;
}
