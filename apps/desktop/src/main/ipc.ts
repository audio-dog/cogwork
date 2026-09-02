import { Effect, Exit, Scope, SubscriptionRef } from "effect";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import { type BrowserWindow, ipcMain, type WebContents } from "electron";
import {
  type EngineStatus,
  IpcChannel,
  type RendererErrorReport,
  type RpcSessionId,
  type WindowPreferences,
} from "../shared/ipc";
import { createDaemonBridgePort, type DaemonBridgePort } from "./daemon-bridge";
import type { EngineSupervisor, EngineSupervisorService } from "./engine-supervisor";
import { mainLogger, rendererLogger } from "./logger";
import { makeMainProcessHealth } from "./process-health";
import type { WindowPreferencesStore } from "./window-preferences";

export interface IpcDeps {
  readonly socketPath: string;
  readonly supervisor: EngineSupervisorService;
  readonly windowPreferences: WindowPreferencesStore;
  readonly runtime: ManagedRuntime.ManagedRuntime<EngineSupervisor, never>;
}

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
  ipcMain.handle(IpcChannel.setWindowPreferences, (_event, preferences: WindowPreferences) =>
    deps.windowPreferences.set(preferences),
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
