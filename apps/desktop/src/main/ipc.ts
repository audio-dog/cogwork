import { Effect, Exit, Scope } from "effect";
import type * as ManagedRuntime from "effect/ManagedRuntime";
import { type BrowserWindow, ipcMain, type WebContents } from "electron";
import {
  type EngineStatus,
  IpcChannel,
  type RendererErrorReport,
  type WindowPreferences,
} from "../shared/ipc";
import { createDaemonBridgePort, type DaemonBridgePort } from "./daemon-bridge";
import type { EngineSupervisor } from "./engine-supervisor";
import { mainLogger, rendererLogger } from "./logger";
import type { WindowPreferencesStore } from "./window-preferences";

export interface IpcDeps {
  readonly socketPath: string;
  readonly supervisor: EngineSupervisor;
  readonly windowPreferences: WindowPreferencesStore;
  readonly runtime: ManagedRuntime.ManagedRuntime<never, never>;
}

// `WebContents.isDestroyed()` stays false after a GPU/renderer crash or during a reload, yet the
// underlying render frame can already be disposed — so `send` throws "Render frame was disposed".
// That throw would otherwise escape the daemon socket's data pump as an uncaught exception. The
// renderer re-subscribes once its frame is back, so dropping the frame here is the correct recovery.
const safeSend = (contents: WebContents, channel: string, payload: unknown): void => {
  if (contents.isDestroyed()) return;
  try {
    contents.send(channel, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    mainLogger.warn(`Dropped ${channel} to a disposed frame: ${message}`);
  }
};

interface RendererSession {
  readonly scope: Scope.Closeable;
  readonly port?: DaemonBridgePort;
}

export const registerIpc = (deps: IpcDeps) => {
  ipcMain.handle(IpcChannel.getEngineStatus, () => deps.supervisor.status);
  ipcMain.handle(IpcChannel.setEngineEnabled, async (_event, enabled: boolean) => {
    await (enabled ? deps.supervisor.start() : deps.supervisor.stop());
    return deps.supervisor.status;
  });

  ipcMain.handle(IpcChannel.getWindowPreferences, () => deps.windowPreferences.get());
  ipcMain.handle(IpcChannel.setWindowPreferences, (_event, preferences: WindowPreferences) =>
    deps.windowPreferences.set(preferences),
  );

  const sessions = new WeakMap<WebContents, RendererSession>();

  const openSession = Effect.fn("DesktopIpc.openSession")(function* (sender: WebContents) {
    const existing = sessions.get(sender);
    if (existing) yield* Scope.close(existing.scope, Exit.void);

    const scope = yield* Scope.fork(deps.runtime.scope);
    const port = yield* createDaemonBridgePort(deps.socketPath, {
      onData: (frame) => safeSend(sender, IpcChannel.rpcData, frame),
      onClosed: (reason) => safeSend(sender, IpcChannel.rpcClosed, reason),
    }).pipe(Scope.provide(scope));
    sessions.set(sender, { scope, port });
    const onDestroyed = () => deps.runtime.runFork(Scope.close(scope, Exit.void));
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
    yield* port.connect.pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
    sessions.set(sender, { scope, port });
    return port;
  });

  ipcMain.handle(IpcChannel.rpcConnect, (event) => deps.runtime.runPromise(openSession(event.sender)));
  ipcMain.on(IpcChannel.rpcSend, (event, frame: string) => {
    const session = sessions.get(event.sender);
    if (!session?.port) return;
    deps.runtime.runFork(Effect.forkIn(session.port.send(frame).pipe(Effect.ignore), session.scope));
  });
  ipcMain.on(IpcChannel.rendererError, (_event, report: RendererErrorReport) => {
    rendererLogger.error(`${report.origin ?? "renderer"}: ${report.message}`, report.stack);
  });
};

export const broadcastEngineStatus = (windows: readonly BrowserWindow[], status: EngineStatus) => {
  for (const window of windows) safeSend(window.webContents, IpcChannel.engineStatusChanged, status);
};
