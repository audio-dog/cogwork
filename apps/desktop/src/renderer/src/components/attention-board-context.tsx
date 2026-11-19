import type { WorkItemRef } from "@cogwork/contracts";
import { createContext, type ReactNode, use, useState } from "react";
import type {
  AnswerChoice,
  NotificationRecord,
  ParkedItem,
  PlanEdits,
  SkippedRecord,
} from "../features/workflow-parks";

export type AttentionLayout = "board" | "list";

export const isAttentionLayout = (value: unknown): value is AttentionLayout =>
  value === "board" || value === "list";

export interface Approval {
  readonly item: ParkedItem;
  readonly digest: string;
  readonly edits: PlanEdits;
}

export interface Rejection {
  readonly item: ParkedItem;
  readonly note: string;
}

export interface HandBack {
  readonly item: ParkedItem;
  readonly note: string;
}

export interface AnswerChosen {
  readonly item: ParkedItem;
  readonly choice: AnswerChoice;
  readonly inputs: Readonly<Record<string, string>>;
}

export interface AttentionState {
  readonly parked: readonly ParkedItem[];
  readonly notifications: readonly NotificationRecord[];
  readonly skipped: readonly SkippedRecord[];
  readonly layout: AttentionLayout;
  readonly focus: string | null;
  readonly failure: string | null;
  readonly notificationFailure: string | null;
}

export interface AttentionActions {
  readonly approve: (approval: Approval) => Promise<boolean>;
  readonly reject: (rejection: Rejection) => Promise<boolean>;
  readonly handBack: (handBack: HandBack) => Promise<boolean>;
  readonly chooseAnswer: (answer: AnswerChosen) => Promise<boolean>;
  readonly dismiss: (notification: NotificationRecord) => Promise<boolean>;
  readonly openItem: (item: WorkItemRef) => void;
  readonly setFocus: (id: string | null) => void;
  readonly setLayout: (layout: AttentionLayout) => void;
  readonly openNotificationSettings: () => void;
}

export type AttentionMeta = Record<string, never>;

interface AttentionContextValue {
  state: AttentionState;
  actions: AttentionActions;
  meta: AttentionMeta;
}

const AttentionContext = createContext<AttentionContextValue | null>(null);

export function useAttention() {
  const value = use(AttentionContext);
  if (!value) throw new Error("Attention parts must render inside Attention.Provider");
  return value;
}

export type ResponseMode = "view" | "edit" | "reject" | "hand-back";

export interface ParkDraft {
  readonly mode: ResponseMode;
  readonly edits: PlanEdits;
  readonly note: string;
  readonly choice: string | null;
  readonly inputs: Readonly<Record<string, string>>;
}

export const emptyDraft: ParkDraft = { mode: "view", edits: {}, note: "", choice: null, inputs: {} };

interface DraftsContextValue {
  state: { drafts: Readonly<Record<string, ParkDraft>> };
  actions: {
    update: (id: string, change: Partial<ParkDraft>) => void;
    discard: (id: string) => void;
  };
  meta: Record<string, never>;
}

const DraftsContext = createContext<DraftsContextValue | null>(null);

export function useDrafts() {
  const value = use(DraftsContext);
  if (!value) throw new Error("Draft parts must render inside Attention.Provider");
  return value;
}

export function AttentionProvider({ children, ...value }: AttentionContextValue & { children: ReactNode }) {
  const [drafts, setDrafts] = useState<Readonly<Record<string, ParkDraft>>>({});
  const discard = (id: string) => setDrafts(({ [id]: _discarded, ...rest }) => rest);
  return (
    <AttentionContext value={value}>
      <DraftsContext
        value={{
          state: { drafts },
          actions: {
            update: (id, change) =>
              setDrafts((current) => ({ ...current, [id]: { ...(current[id] ?? emptyDraft), ...change } })),
            discard,
          },
          meta: {},
        }}
      >
        {children}
      </DraftsContext>
    </AttentionContext>
  );
}
