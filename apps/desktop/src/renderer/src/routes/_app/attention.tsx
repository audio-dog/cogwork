import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Attention, type AttentionLayout, isAttentionLayout } from "../../components/attention-board";
import { useNow } from "../../features/use-now";
import {
  mockNotifications,
  mockParkedItems,
  mockSkippedRecords,
} from "../../features/workflow-parks-mock-data";

interface AttentionSearch {
  readonly layout: AttentionLayout;
  readonly focus?: string;
}

export const Route = createFileRoute("/_app/attention")({
  validateSearch: (search: Record<string, unknown>): AttentionSearch => ({
    layout: isAttentionLayout(search.layout) ? search.layout : "board",
    focus: typeof search.focus === "string" ? search.focus : undefined,
  }),
  component: AttentionRoute,
});

/** Mock data until the read model carries Workflow parks; a command only removes what it cleared. */
function AttentionRoute() {
  const { layout, focus } = Route.useSearch();
  const navigate = useNavigate();
  const now = useNow(60_000);
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set());
  const clear = (id: string) => setCleared((current) => new Set([...current, id]));
  const go = (next: Partial<AttentionSearch>) =>
    navigate({ to: "/attention", search: { layout, focus, ...next }, replace: true });

  return (
    <Attention.Provider
      state={{
        parked: mockParkedItems.filter((item) => !cleared.has(item.id)),
        notifications: mockNotifications.filter((notification) => !cleared.has(notification.id)),
        skipped: mockSkippedRecords,
        layout,
        focus: focus ?? null,
      }}
      actions={{
        approve: ({ item }) => clear(item.id),
        reject: ({ item }) => clear(item.id),
        handBack: ({ item }) => clear(item.id),
        dismiss: (notification) => clear(notification.id),
        openItem: () => undefined,
        setFocus: (id) => go({ focus: id ?? undefined }),
        setLayout: (next) => go({ layout: next }),
      }}
      meta={{ now }}
    >
      <Attention.Frame>
        <Attention.Lanes />
      </Attention.Frame>
    </Attention.Provider>
  );
}
