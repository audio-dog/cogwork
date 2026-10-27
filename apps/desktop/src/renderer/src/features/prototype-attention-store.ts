import { create } from "zustand";
import { type NotificationRecord, type ParkedItem, planDigest } from "./prototype-attention-data";

/**
 * PROTOTYPE — issue #794. Stands in for the daemon: each command records the RPC the surface would
 * send, and the read model drops what that command cleared.
 */

export type ResponseMode = "view" | "edit" | "reject" | "hand-back";

interface PrototypeAttentionState {
  readonly resolved: Readonly<Record<string, true>>;
  readonly dismissed: Readonly<Record<string, true>>;
  readonly edits: Readonly<Record<string, string>>;
  readonly modes: Readonly<Record<string, ResponseMode>>;
  readonly notes: Readonly<Record<string, string>>;
  readonly lastCommand: string | null;
  readonly banner: string | null;
  readonly setMode: (item: ParkedItem, mode: ResponseMode) => void;
  readonly cancel: (item: ParkedItem) => void;
  readonly setEdit: (key: string, text: string) => void;
  readonly setNote: (item: ParkedItem, text: string) => void;
  readonly approve: (item: ParkedItem) => void;
  readonly reject: (item: ParkedItem) => void;
  readonly handBack: (item: ParkedItem) => void;
  readonly dismiss: (notification: NotificationRecord) => void;
  readonly open: (ref: string) => void;
  readonly showBanner: (id: string) => void;
  readonly clearBanner: () => void;
  readonly reset: () => void;
}

const initial = {
  resolved: {},
  dismissed: {},
  edits: {},
  modes: {},
  notes: {},
  lastCommand: null,
  banner: null,
};

const withoutItem = <Value>(record: Readonly<Record<string, Value>>, item: ParkedItem) =>
  Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== item.id && !key.startsWith(`${item.id}/`)),
  );

const noteField = (note: string | undefined) => (note?.trim() ? `, note: "${note.trim()}"` : "");

export const usePrototypeAttention = create<PrototypeAttentionState>((set) => ({
  ...initial,
  setMode: (item, mode) => set((state) => ({ modes: { ...state.modes, [item.id]: mode } })),
  cancel: (item) =>
    set((state) => ({
      modes: withoutItem(state.modes, item),
      edits: withoutItem(state.edits, item),
      notes: withoutItem(state.notes, item),
    })),
  setEdit: (key, text) => set((state) => ({ edits: { ...state.edits, [key]: text } })),
  setNote: (item, text) => set((state) => ({ notes: { ...state.notes, [item.id]: text } })),
  approve: (item) =>
    set((state) => ({
      resolved: { ...state.resolved, [item.id]: true },
      lastCommand: `Approve { item: "${item.id}", digest: "${planDigest(item, state.edits)}" }`,
    })),
  reject: (item) =>
    set((state) => ({
      resolved: { ...state.resolved, [item.id]: true },
      lastCommand: `Reject { item: "${item.id}", digest: "${planDigest(item, state.edits)}"${noteField(state.notes[item.id])} }`,
    })),
  handBack: (item) =>
    set((state) => ({
      resolved: { ...state.resolved, [item.id]: true },
      lastCommand: `HandBack { item: "${item.id}"${noteField(state.notes[item.id])} }`,
    })),
  dismiss: (notification) =>
    set((state) => ({
      dismissed: { ...state.dismissed, [notification.id]: true },
      lastCommand: `Dismiss { notification: "${notification.id}" }`,
    })),
  open: (ref) => set({ lastCommand: `open the item tab for ${ref} (no RPC)` }),
  showBanner: (id) => set({ banner: id }),
  clearBanner: () => set({ banner: null }),
  reset: () => set(initial),
}));
