import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Attention, type AttentionLayout, isAttentionLayout } from "../../components/attention-board";
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

function AttentionRoute() {
  const { layout, focus } = Route.useSearch();
  const navigate = useNavigate();
  const [resolved, setResolved] = useState<ReadonlySet<string>>(new Set());
  const resolve = (id: string) => setResolved((current) => new Set([...current, id]));
  const updateSearch = (next: Partial<AttentionSearch>) =>
    navigate({ to: "/attention", search: { layout, focus, ...next }, replace: true });

  return (
    <Attention.Provider
      state={{
        parked: mockParkedItems.filter((item) => !resolved.has(item.id)),
        notifications: mockNotifications.filter((notification) => !resolved.has(notification.id)),
        skipped: mockSkippedRecords,
        layout,
        focus: focus ?? null,
      }}
      actions={{
        approve: ({ item }) => resolve(item.id),
        reject: ({ item }) => resolve(item.id),
        handBack: ({ item }) => resolve(item.id),
        chooseAnswer: ({ item }) => resolve(item.id),
        dismiss: (notification) => resolve(notification.id),
        openItem: () => undefined,
        setFocus: (id) => updateSearch({ focus: id ?? undefined }),
        setLayout: (next) => updateSearch({ layout: next }),
      }}
      meta={{}}
    >
      <Attention.Frame>
        <Attention.Lanes />
      </Attention.Frame>
    </Attention.Provider>
  );
}
