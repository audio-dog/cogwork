import { keyOf, type WorkflowPark, type WorkflowRecord } from "@cogwork/contracts";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useUpdateEffect } from "@react-hookz/web";
import { useRouter } from "@tanstack/react-router";
import { useRef, useSyncExternalStore } from "react";

import {
  type DesktopNotificationRequest,
  type DesktopNotificationStatus,
  desktopNotificationIdOf,
  desktopNotificationLimits,
} from "../../../shared/ipc";
import { workflowAttentionAtom } from "../daemon/atoms";
import { reportRendererError } from "./report-error";

type NotificationPark = Pick<WorkflowPark, "item" | "summary">;

const parkRequests = (parks: readonly NotificationPark[]) =>
  parks.map((park) => {
    const focus = keyOf(park.item);
    const id = desktopNotificationIdOf(focus);
    return {
      id,
      focus,
      title: "Cogwork needs you",
      body: `${focus}: ${park.summary}`.slice(0, desktopNotificationLimits.body),
    } satisfies DesktopNotificationRequest;
  });

export const notificationChanges = (previous: ReadonlySet<string>, parks: readonly NotificationPark[]) => {
  const current = parkRequests(parks);
  const next = new Set<string>(current.map(({ id }) => id));
  return {
    next,
    current,
    changed: current.some(({ id }) => !previous.has(id)) || [...previous].some((id) => !next.has(id)),
  };
};

interface NotificationSnapshot {
  readonly status: DesktopNotificationStatus;
  readonly navigation: string | null;
}

const notificationStore: {
  snapshot: NotificationSnapshot;
  listeners: Set<() => void>;
  unsubscribeStatus: (() => void) | null;
  unsubscribeNavigation: (() => void) | null;
} = {
  snapshot: { status: { _tag: "inactive" }, navigation: null },
  listeners: new Set(),
  unsubscribeStatus: null,
  unsubscribeNavigation: null,
};

const publishSnapshot = (change: Partial<NotificationSnapshot>) => {
  notificationStore.snapshot = { ...notificationStore.snapshot, ...change };
  notificationStore.listeners.forEach((listener) => {
    listener();
  });
};

const takeNavigation = () =>
  window.cogwork.notifications
    .takeNavigation()
    .then((navigation) => {
      if (navigation) publishSnapshot({ navigation });
    })
    .catch((error) => reportRendererError(error, "desktop notifications"));

const subscribe = (listener: () => void) => {
  notificationStore.listeners.add(listener);
  if (notificationStore.listeners.size === 1) {
    window.cogwork.notifications
      .getStatus()
      .then((status) => publishSnapshot({ status }))
      .catch((error) => reportRendererError(error, "desktop notifications"));
    notificationStore.unsubscribeStatus = window.cogwork.notifications.onStatus((status) =>
      publishSnapshot({ status }),
    );
    notificationStore.unsubscribeNavigation = window.cogwork.notifications.onNavigation(takeNavigation);
    takeNavigation();
  }
  return () => {
    notificationStore.listeners.delete(listener);
    if (notificationStore.listeners.size > 0) return;
    notificationStore.unsubscribeStatus?.();
    notificationStore.unsubscribeNavigation?.();
    notificationStore.unsubscribeStatus = null;
    notificationStore.unsubscribeNavigation = null;
  };
};

const getSnapshot = () => notificationStore.snapshot;

const useDesktopNotificationSnapshot = () => useSyncExternalStore(subscribe, getSnapshot);

export const useDesktopNotificationStatus = () => useDesktopNotificationSnapshot().status;

export function DesktopNotificationCoordinator({
  workflows,
  activityOrdinal,
}: {
  readonly workflows: readonly WorkflowRecord[];
  readonly activityOrdinal: number;
}) {
  const router = useRouter();
  const attention = useAtomValue(workflowAttentionAtom);
  const refreshAttention = useAtomRefresh(workflowAttentionAtom);
  const { navigation } = useDesktopNotificationSnapshot();
  const previous = useRef<ReadonlySet<string>>(new Set());
  const hasSynced = useRef(false);
  const notificationSync = useRef(Promise.resolve());
  const hasEnabledWorkflow = workflows.some(({ enabled }) => enabled);
  const parks = attention._tag === "Success" ? attention.value.parks : null;

  useUpdateEffect(refreshAttention, [refreshAttention, activityOrdinal]);
  useUpdateEffect(() => {
    if (!parks) return;
    const changes = notificationChanges(previous.current, parks);
    const shouldSync = hasEnabledWorkflow || previous.current.size > 0 || changes.current.length > 0;
    if (!shouldSync) return;
    if (hasSynced.current && !changes.changed) return;
    const reconcile = () =>
      window.cogwork.notifications
        .enable()
        .then(() => window.cogwork.notifications.sync(changes.current))
        .then(() => undefined);
    notificationSync.current = notificationSync.current
      .then(() => reconcile().catch(reconcile))
      .then(() => {
        previous.current = changes.next;
        hasSynced.current = true;
      })
      .catch((error) => reportRendererError(error, "desktop notifications"));
  }, [parks, hasEnabledWorkflow]);
  useUpdateEffect(() => {
    if (!navigation || !parks) return;
    const known = parks.some((park) => keyOf(park.item) === navigation);
    publishSnapshot({ navigation: null });
    if (!known) return;
    router
      .navigate({ to: "/attention", search: { layout: "board", focus: navigation } })
      .catch((error) => reportRendererError(error, "desktop notification navigation"));
  }, [parks, navigation, router]);

  return null;
}
