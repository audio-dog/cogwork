import type { DesktopNotificationRequest, DesktopNotificationStatus } from "../shared/ipc";

export interface DesktopNotificationHandle {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly close: () => void;
  readonly show: () => void;
  on(event: "click", listener: () => void): unknown;
  on(event: "failed", listener: (event: unknown, error: string) => void): unknown;
}

interface DesktopNotificationDeps {
  readonly create: (request: DesktopNotificationRequest) => DesktopNotificationHandle;
  readonly getHistory: () => Promise<readonly DesktopNotificationHandle[]>;
  readonly isSupported: () => boolean;
  readonly remove: (id: string) => void;
  readonly registerActivation: (listener: (id: string) => void) => void;
  readonly showWindow: () => void;
  readonly navigate: (id: string) => void;
  readonly publishStatus: (status: DesktopNotificationStatus) => void;
  readonly logFailure: (message: string) => void;
  readonly openSettings: () => Promise<boolean>;
  readonly launchIdentifier: string | null;
}

const inactiveStatus = { _tag: "inactive" } as const satisfies DesktopNotificationStatus;
const readyStatus = { _tag: "ready" } as const satisfies DesktopNotificationStatus;
const maximumNotificationIdLength = 64;

const validId = (id: string) => id.length > 0 && id.length <= maximumNotificationIdLength;

export const attentionFocusFromUrl = (value: string) => {
  const url = URL.parse(value);
  if (url?.protocol !== "cogwork:") return null;
  if (url.hostname !== "attention" || (url.pathname !== "" && url.pathname !== "/")) return null;
  if (url.username || url.password || url.port || url.hash) return null;
  if ([...url.searchParams.keys()].length !== 1 || !url.searchParams.has("focus")) return null;
  const focus = url.searchParams.get("focus") ?? "";
  return validId(focus) ? focus : null;
};

export const notificationIdFromActivation = (value: string) => new URLSearchParams(value).get("tag") ?? value;

export const createDesktopNotifications = (deps: DesktopNotificationDeps) => {
  const state: {
    enabled: boolean;
    supported: boolean;
    enablePromise: Promise<DesktopNotificationStatus> | null;
    status: DesktopNotificationStatus;
    live: Map<string, DesktopNotificationHandle>;
    knownIds: ReadonlySet<string>;
    hasReadModel: boolean;
    pendingCandidate: string | null;
    pendingNavigation: string | null;
  } = {
    enabled: false,
    supported: false,
    enablePromise: null,
    status: inactiveStatus,
    live: new Map(),
    knownIds: new Set(),
    hasReadModel: false,
    pendingCandidate: deps.launchIdentifier,
    pendingNavigation: null,
  };

  const publishStatus = (status: DesktopNotificationStatus) => {
    state.status = status;
    deps.publishStatus(status);
    return status;
  };

  const fail = (message: string) => {
    deps.logFailure(message);
    return publishStatus({ _tag: "failed", message });
  };

  const flushNavigation = () => {
    const candidate = state.pendingCandidate;
    if (!candidate || !state.hasReadModel) return;
    state.pendingCandidate = null;
    if (!state.knownIds.has(candidate)) return;
    state.pendingNavigation = candidate;
    deps.navigate(candidate);
  };

  const requestNavigation = (id: string) => {
    deps.showWindow();
    if (!validId(id)) return;
    state.pendingCandidate = id;
    flushNavigation();
  };

  const attach = (notification: DesktopNotificationHandle) => {
    notification.on("click", () => requestNavigation(notification.id));
    notification.on("failed", (_event, error) => fail(error));
    state.live.set(notification.id, notification);
  };

  const enableOnce = async () => {
    state.enabled = true;
    if (!deps.isSupported()) return fail("OS notifications are not supported on this system");
    state.supported = true;
    try {
      deps.registerActivation(requestNavigation);
      const history = await deps.getHistory();
      history.filter(({ id }) => validId(id)).forEach(attach);
      const status = publishStatus(readyStatus);
      flushNavigation();
      return status;
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  };

  const enable = () => {
    state.enablePromise ??= enableOnce();
    return state.enablePromise;
  };

  const sync = async (requests: readonly DesktopNotificationRequest[]) => {
    if (!state.enabled) return state.status;
    await state.enablePromise;
    if (!state.supported) return state.status;
    const validRequests = requests.filter(({ id }) => validId(id));
    const knownIds = new Set(validRequests.map(({ id }) => id));
    [...state.live.entries()]
      .filter(([id]) => !knownIds.has(id))
      .forEach(([id, notification]) => {
        notification.close();
        deps.remove(id);
        state.live.delete(id);
      });
    validRequests
      .filter(({ id }) => !state.live.has(id))
      .filter(() => state.status._tag !== "failed")
      .forEach((request) => {
        const notification = deps.create(request);
        attach(notification);
        notification.show();
      });
    state.knownIds = knownIds;
    state.hasReadModel = true;
    flushNavigation();
    return state.status;
  };

  const openUrl = (url: string) => {
    deps.showWindow();
    const focus = attentionFocusFromUrl(url);
    if (!focus) return;
    state.pendingCandidate = focus;
    flushNavigation();
  };

  const takeNavigation = () => {
    const pending = state.pendingNavigation;
    state.pendingNavigation = null;
    return pending;
  };

  const closeAll = () => {
    [...state.live.entries()].forEach(([id, notification]) => {
      notification.close();
      deps.remove(id);
    });
    state.live.clear();
  };

  return {
    enable,
    sync,
    openUrl,
    takeNavigation,
    getStatus: () => state.status,
    openSettings: deps.openSettings,
    closeAll,
  } as const;
};

export type DesktopNotifications = ReturnType<typeof createDesktopNotifications>;
