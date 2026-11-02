import {
  ProcessProfileCapture,
  ProcessProfileError,
  ProcessProfileInput,
} from "@cogwork/process-diagnostics";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { type BrowserWindow, ipcMain, type WebContents } from "electron";
import {
  type DesktopNotificationRequest,
  type DesktopNotificationStatus,
  type EngineStatus,
  IpcChannel,
  type RendererErrorReport,
  type RpcSessionId,
  type WindowPreferences,
} from "../shared/ipc";
import { createDaemonBridgePort, type DaemonBridgePort } from "./daemon-bridge";
import type { DesktopNotifications } from "./desktop-notifications";
import type { EngineSupervisor, EngineSupervisorService } from "./engine-supervisor";
import { mainLogger, rendererLogger } from "./logger";
import { makeMainProcessHealth } from "./process-health";
import type { WindowPreferencesStore } from "./window-preferences";

export interface IpcDeps {
  readonly socketPath: string;
  readonly supervisor: EngineSupervisorService;
  readonly windowPreferences: WindowPreferencesStore;
  readonly diagnosticsDirectory: string;
  readonly captureMainProfile: (input: ProcessProfileInput) => Effect.Effect<string, ProcessProfileError>;
  readonly isTrustedSender: (sender: WebContents) => boolean;
  readonly runtime: ManagedRuntime.ManagedRuntime<EngineSupervisor, never>;
  readonly notifications: DesktopNotifications;
}

const isDesktopNotificationRequest = (value: unknown): value is DesktopNotificationRequest =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "string" &&
  "title" in value &&
  typeof value.title === "string" &&
  "body" in value &&
  typeof value.body === "string";

const notificationRequests = (input: unknown) =>
  Array.isArray(input) ? input.filter(isDesktopNotificationRequest) : [];

const WindowPreferencesSchema = Schema.Struct({
  closeToHide: Schema.optionalKey(Schema.Boolean),
  profiling: Schema.optionalKey(Schema.Boolean),
});
const decodePreferences = Schema.decodeUnknownOption(WindowPreferencesSchema);
const decodeProfileCapture = Schema.decodeUnknownOption(ProcessProfileCapture);
const profileCaptureCooldownMillis = 60_000;
const profileCaptureTimeout = "2 minutes";

const diagnosticsFailure = (operation: string) => (cause: unknown) =>
  ProcessProfileError.make({ operation, cause });

const captureFailure = diagnosticsFailure("capture process profile");
const preferencesFailure = diagnosticsFailure("change desktop preferences");

const rendererProfileError = (error: ProcessProfileError) =>
  new Error(`${error.operation}: ${String(error.cause)}`);

const authorizeDiagnostics = (
  deps: IpcDeps,
  sender: WebContents,
  fail: (cause: unknown) => ProcessProfileError,
) => {
  if (deps.isTrustedSender(sender)) return Effect.void;
  return fail("Diagnostics are unavailable from this renderer");
};

const isOwnedStatus = (status: EngineStatus) => status === "starting" || status === "running";

const restartSupervisorIfOwned = Effect.fn("DesktopIpc.restartSupervisorIfOwned")(function* (
  supervisor: EngineSupervisorService,
  saved: WindowPreferences,
) {
  const status = yield* SubscriptionRef.get(supervisor.status);
  if (!isOwnedStatus(status)) return saved;
  yield* supervisor.stop;
  yield* supervisor.start;
  return saved;
});

const heapSnapshotInput = (directory: string) => ProcessProfileInput.cases.HeapSnapshot.make({ directory });

const cpuProfileInput = (directory: string) =>
  ProcessProfileInput.cases.CpuProfile.make({ directory, durationMillis: 30_000 });

const captureProfile = Effect.fn("DesktopIpc.captureProfile")(function* (
  deps: IpcDeps,
  capture: ProcessProfileCapture,
) {
  if (!deps.windowPreferences.get().profiling) return yield* captureFailure("Profiling is disabled");
  const captureEffect = ProcessProfileCapture.match(capture, {
    DaemonHeapSnapshot: () => deps.supervisor.captureProfile(heapSnapshotInput(deps.diagnosticsDirectory)),
    DaemonCpuProfile: () => deps.supervisor.captureProfile(cpuProfileInput(deps.diagnosticsDirectory)),
    MainHeapSnapshot: () => deps.captureMainProfile(heapSnapshotInput(deps.diagnosticsDirectory)),
    MainCpuProfile: () => deps.captureMainProfile(cpuProfileInput(deps.diagnosticsDirectory)),
  });
  return yield* captureEffect.pipe(
    Effect.timeout(profileCaptureTimeout),
    Effect.catchTag("TimeoutError", (cause) => captureFailure(cause)),
  );
});

const makeCaptureProfileHandler = (deps: IpcDeps) => {
  const gate = Semaphore.makeUnsafe(1);
  const lastStartedAt = Ref.makeUnsafe(0);
  const runCapture = Effect.fn("DesktopIpc.runLimitedCapture")(function* (input: unknown) {
    const capture = Option.getOrNull(decodeProfileCapture(input));
    if (!capture) return yield* captureFailure("Invalid process profile request");
    const now = yield* Clock.currentTimeMillis;
    const previous = yield* Ref.get(lastStartedAt);
    if (now - previous < profileCaptureCooldownMillis) {
      return yield* captureFailure("Wait before starting another process profile");
    }
    return yield* captureProfile(deps, capture).pipe(Effect.tap(() => Ref.set(lastStartedAt, now)));
  });
  return Effect.fn("DesktopIpc.captureProfileHandler")(function* (sender: WebContents, input: unknown) {
    yield* authorizeDiagnostics(deps, sender, captureFailure);
    const result = yield* gate.withPermitsIfAvailable(1)(runCapture(input));
    if (Option.isNone(result)) return yield* captureFailure("A process profile is already running");
    return result.value;
  });
};

const setWindowPreferences = Effect.fn("DesktopIpc.setWindowPreferences")(function* (
  deps: IpcDeps,
  sender: WebContents,
  input: unknown,
) {
  yield* authorizeDiagnostics(deps, sender, preferencesFailure);
  const preferences = Option.getOrNull(decodePreferences(input));
  if (!preferences || (preferences.closeToHide === undefined && preferences.profiling === undefined)) {
    return yield* preferencesFailure("Invalid desktop preferences");
  }
  const previous = deps.windowPreferences.get();
  if (preferences.profiling === true && !previous.profiling) {
    const status = yield* SubscriptionRef.get(deps.supervisor.status);
    if (status === "adopted") {
      return yield* preferencesFailure("Stop the standalone daemon before enabling profiling");
    }
  }
  const saved = deps.windowPreferences.set(preferences);
  if (previous.profiling === saved.profiling) return saved;
  return yield* restartSupervisorIfOwned(deps.supervisor, saved).pipe(
    Effect.onError(() => Effect.sync(() => deps.windowPreferences.set(previous))),
  );
});

// `WebContents.isDestroyed()` stays false after a GPU/renderer crash or during a reload, yet the
// underlying render frame can already be disposed — so `send` throws "Render frame was disposed".
// That throw would otherwise escape the daemon socket's data pump as an uncaught exception. The
// renderer re-subscribes once its frame is back, so dropping the frame here is the correct recovery.
const safeSend = (contents: WebContents, channel: string, payload: unknown) => {
  if (contents.isDestroyed()) return false;
  try {
    contents.send(channel, payload);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    mainLogger.warn(`Dropped ${channel} to a disposed frame: ${message}`);
    return false;
  }
};

interface RendererSession {
  readonly scope: Scope.Closeable;
  readonly port?: DaemonBridgePort;
}

const closeSessionScope = (scope: Scope.Closeable) => Scope.close(scope, Exit.void);

export const registerIpc = (deps: IpcDeps) => {
  const captureProfileHandler = makeCaptureProfileHandler(deps);
  const processHealth = makeMainProcessHealth();
  deps.runtime.runFork(Scope.addFinalizer(deps.runtime.scope, processHealth.close));
  ipcMain.handle(IpcChannel.getEngineStatus, () =>
    deps.runtime.runPromise(SubscriptionRef.get(deps.supervisor.status)),
  );
  ipcMain.handle(IpcChannel.setEngineEnabled, (_event, enabled: boolean) =>
    deps.runtime.runPromise(
      (enabled ? deps.supervisor.start : deps.supervisor.stop).pipe(
        Effect.andThen(SubscriptionRef.get(deps.supervisor.status)),
      ),
    ),
  );

  ipcMain.handle(IpcChannel.getWindowPreferences, () => deps.windowPreferences.get());
  ipcMain.handle(IpcChannel.getMainProcessHealth, () => deps.runtime.runPromise(processHealth.sample));
  ipcMain.handle(IpcChannel.setWindowPreferences, (event, preferences: unknown) =>
    deps.runtime.runPromise(
      setWindowPreferences(deps, event.sender, preferences).pipe(Effect.mapError(rendererProfileError)),
    ),
  );

  ipcMain.handle(IpcChannel.captureProcessProfile, (event, capture: unknown) =>
    deps.runtime.runPromise(
      captureProfileHandler(event.sender, capture).pipe(Effect.mapError(rendererProfileError)),
    ),
  );

  ipcMain.handle(IpcChannel.enableDesktopNotifications, (event) =>
    deps.isTrustedSender(event.sender) ? deps.notifications.enable() : deps.notifications.getStatus(),
  );
  ipcMain.handle(IpcChannel.syncDesktopNotifications, (event, input: unknown) =>
    deps.isTrustedSender(event.sender)
      ? deps.notifications.sync(notificationRequests(input))
      : deps.notifications.getStatus(),
  );
  ipcMain.handle(IpcChannel.getDesktopNotificationStatus, () => deps.notifications.getStatus());
  ipcMain.handle(IpcChannel.takeDesktopNotificationNavigation, (event) =>
    deps.isTrustedSender(event.sender) ? deps.notifications.takeNavigation() : null,
  );
  ipcMain.handle(IpcChannel.openNotificationSettings, (event) =>
    deps.isTrustedSender(event.sender) ? deps.notifications.openSettings() : false,
  );

  const sessions = new WeakMap<WebContents, RendererSession>();

  const closeSession = (sender: WebContents) => {
    const session = sessions.get(sender);
    if (!session) return Effect.void;
    return closeSessionScope(session.scope);
  };

  const openSession = Effect.fn("DesktopIpc.openSession")(function* (
    sender: WebContents,
    sessionId: RpcSessionId,
  ) {
    yield* closeSession(sender);

    const scope = yield* Scope.fork(deps.runtime.scope);
    const port = yield* createDaemonBridgePort(deps.socketPath, {
      onData: (frame) => {
        if (safeSend(sender, IpcChannel.rpcData, { sessionId, frame })) {
          processHealth.recordToRenderer();
        }
      },
      onClosed: (reason) => safeSend(sender, IpcChannel.rpcClosed, { sessionId, reason }),
    }).pipe(Scope.provide(scope));
    const onDestroyed = () => deps.runtime.runFork(closeSessionScope(scope));
    sender.once("destroyed", onDestroyed);
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => sender.off("destroyed", onDestroyed)),
    );
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => sessions.delete(sender)),
    );
    sessions.set(sender, { scope });
    yield* port.connect.pipe(Effect.onError(() => closeSessionScope(scope)));
    // The port never crosses IPC: the renderer contract is `Promise<void>`, and Electron cannot
    // structured-clone an object of Effects. `rpcSend` reads the port from `sessions` instead.
    sessions.set(sender, { scope, port });
  });

  ipcMain.handle(IpcChannel.rpcConnect, (event, sessionId: RpcSessionId) =>
    deps.runtime.runPromise(openSession(event.sender, sessionId)),
  );
  ipcMain.handle(IpcChannel.rpcDisconnect, (event) => deps.runtime.runPromise(closeSession(event.sender)));
  ipcMain.on(IpcChannel.rpcSend, (event, frame: string) => {
    const session = sessions.get(event.sender);
    if (!session?.port) return;
    deps.runtime.runFork(
      Effect.forkIn(
        session.port.send(frame).pipe(
          Effect.tap(() => Effect.sync(processHealth.recordToDaemon)),
          Effect.ignore,
        ),
        session.scope,
      ),
    );
  });
  ipcMain.on(IpcChannel.rendererError, (_event, report: RendererErrorReport) => {
    rendererLogger.error(`${report.origin ?? "renderer"}: ${report.message}`, report.stack);
  });
};

export const broadcastEngineStatus = (windows: readonly BrowserWindow[], status: EngineStatus) => {
  for (const window of windows) safeSend(window.webContents, IpcChannel.engineStatusChanged, status);
};

export const broadcastSystemResume = (windows: readonly BrowserWindow[]) => {
  windows.forEach((window) => {
    safeSend(window.webContents, IpcChannel.systemResumed, undefined);
  });
};

export const broadcastDesktopNotificationStatus = (
  windows: readonly BrowserWindow[],
  status: DesktopNotificationStatus,
) => {
  windows.forEach((window) => {
    safeSend(window.webContents, IpcChannel.desktopNotificationStatusChanged, status);
  });
};

export const broadcastDesktopNotificationNavigation = (windows: readonly BrowserWindow[]) => {
  windows.forEach((window) => {
    safeSend(window.webContents, IpcChannel.desktopNotificationNavigation, undefined);
  });
};
