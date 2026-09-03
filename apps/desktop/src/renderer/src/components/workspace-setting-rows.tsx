import { Input } from "@cogwork/ui/components/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@cogwork/ui/components/item";
import { createContext, type ReactNode, use } from "react";
import type { WorkspaceRecordDraft } from "../features/workspace-record";

export type PatchDraft = (next: Partial<WorkspaceRecordDraft>) => void;

interface WorkspaceRecordState {
  readonly draft: WorkspaceRecordDraft;
}

interface WorkspaceRecordActions {
  readonly patch: PatchDraft;
}

interface WorkspaceRecordMeta {
  readonly disabled: boolean;
}

export interface WorkspaceRecordValue {
  readonly state: WorkspaceRecordState;
  readonly actions: WorkspaceRecordActions;
  readonly meta: WorkspaceRecordMeta;
}

const WorkspaceRecordContext = createContext<WorkspaceRecordValue | null>(null);

function useWorkspaceRecord() {
  const value = use(WorkspaceRecordContext);
  if (!value) throw new Error("Workspace record rows must render inside a WorkspaceRecord.Provider");
  return value;
}

function WorkspaceRecordProvider({
  value,
  children,
}: {
  readonly value: WorkspaceRecordValue;
  readonly children: ReactNode;
}) {
  return <WorkspaceRecordContext value={value}>{children}</WorkspaceRecordContext>;
}

function SettingRow({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) {
  return (
    <Item className="rounded-lg">
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription>{description}</ItemDescription>
      </ItemContent>
      <ItemActions>{children}</ItemActions>
    </Item>
  );
}

function CheckoutRows() {
  const {
    state: { draft },
    actions: { patch },
    meta: { disabled },
  } = useWorkspaceRecord();
  return (
    <SettingRow
      title="Checkout path"
      description="Change it to re-bind. Every setting and Run survives the move."
    >
      <Input
        aria-label="Checkout path"
        value={draft.checkoutPath}
        placeholder="/Users/you/sites/cogwork"
        className="w-80 font-mono text-xs"
        disabled={disabled}
        onChange={(event) => patch({ checkoutPath: event.target.value })}
      />
    </SettingRow>
  );
}

export const WorkspaceRecord = {
  Provider: WorkspaceRecordProvider,
  CheckoutRows,
};
