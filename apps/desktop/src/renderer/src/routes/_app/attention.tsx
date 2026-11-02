import { WorkItemRef } from "@cogwork/contracts";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Attention, type AttentionLayout, isAttentionLayout } from "../../components/attention-board";
import {
  approveWorkflowPlanAtom,
  chooseWorkflowAnswerAtom,
  dismissWorkflowNotificationAtom,
  handBackAtom,
  rejectWorkflowPlanAtom,
  workflowAttentionAtom,
  workflowNotificationsAtom,
} from "../../daemon/atoms";
import { AttentionClientProvider } from "../../features/attention-session";
import { useDesktopNotificationStatus } from "../../features/desktop-notifications";
import { useWorkflowSession } from "../../features/workflow-session";
import { useRightPanelStore } from "../../store/right-panel";

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
  const navigate = useNavigate({ from: "/attention" });
  const attentionResult = useAtomValue(workflowAttentionAtom);
  const notificationsResult = useAtomValue(workflowNotificationsAtom);
  const refreshAttention = useAtomRefresh(workflowAttentionAtom);
  const refreshNotifications = useAtomRefresh(workflowNotificationsAtom);
  const approve = useAtomSet(approveWorkflowPlanAtom, { mode: "promise" });
  const reject = useAtomSet(rejectWorkflowPlanAtom, { mode: "promise" });
  const handBack = useAtomSet(handBackAtom, { mode: "promise" });
  const chooseAnswer = useAtomSet(chooseWorkflowAnswerAtom, { mode: "promise" });
  const dismiss = useAtomSet(dismissWorkflowNotificationAtom, { mode: "promise" });
  const { state } = useWorkflowSession();
  const notificationStatus = useDesktopNotificationStatus();
  const openItem = useRightPanelStore((panel) => panel.openItem);
  const attention = attentionResult._tag === "Success" ? attentionResult.value : null;
  const notifications = notificationsResult._tag === "Success" ? notificationsResult.value : [];
  if (!attention || !state.catalog) return null;
  const updateSearch = (next: Partial<AttentionSearch>) =>
    navigate({ search: (current) => ({ ...current, ...next }), replace: true });
  const refresh = () => {
    refreshAttention();
    refreshNotifications();
  };

  return (
    <AttentionClientProvider
      snapshot={{ attention, notifications, workflows: state.workflows, catalog: state.catalog }}
      client={{
        approve: (payload) => approve({ payload }),
        reject: (payload) => reject({ payload }),
        handBack: (payload) => handBack({ payload }),
        chooseAnswer: (payload) => chooseAnswer({ payload }),
        dismiss: (payload) => dismiss({ payload }),
      }}
      layout={layout}
      focus={focus ?? null}
      onFocusChange={(id) => {
        updateSearch({ focus: id ?? undefined });
      }}
      onLayoutChange={(next) => {
        updateSearch({ layout: next });
      }}
      onOpenItem={(item) => {
        if (WorkItemRef.guards.Issue(item)) openItem(item.workspace, item.id);
      }}
      onRefresh={refresh}
      notificationFailure={notificationStatus._tag === "failed" ? notificationStatus.message : null}
      onOpenNotificationSettings={() => {
        window.cogwork.notifications.openSettings();
      }}
    >
      <Attention.Frame>
        <Attention.Lanes />
      </Attention.Frame>
    </AttentionClientProvider>
  );
}
