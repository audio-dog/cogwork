import type { SchedulingState } from "@cogwork/contracts";
import { type BrowserWindow, ipcMain, type WebContents } from "electron";
import { type EngineStatus, IpcChannel, type RendererErrorReport } from "../shared/ipc";
import { createDaemonBridgePort, type DaemonBridgePort } from "./daemon-bridge";
import type { EngineSupervisor } from "./engine-supervisor";
import { mainLogger, rendererLogger } from "./logger";

export interface IpcDeps {
  readonly socketPath: string;
  readonly supervisor: EngineSupervisor;
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
    mainLogger.warn(`Dropped ${channel} to a disposed frame: ${(error as Error).message}`);
  }
};

export const registerIpc = (deps: IpcDeps) => {
  ipcMain.handle(IpcChannel.getEngineStatus, () => deps.supervisor.status);
  ipcMain.handle(IpcChannel.setEngineEnabled, async (_event, enabled: boolean) => {
    await (enabled ? deps.supervisor.start() : deps.supervisor.stop());
    return deps.supervisor.status;
  });
  ipcMain.on(IpcChannel.setSchedulingState, (_event, desired: SchedulingState) => {
    deps.supervisor.setScheduling(desired);
  });

  const ports = new Map<number, DaemonBridgePort>();

  const portFor = (sender: WebContents): DaemonBridgePort => {
    const existing = ports.get(sender.id);
    if (existing) return existing;
    const port = createDaemonBridgePort(deps.socketPath, {
      onData: (frame) => safeSend(sender, IpcChannel.rpcData, frame),
      onClosed: (reason) => safeSend(sender, IpcChannel.rpcClosed, reason),
    });
    ports.set(sender.id, port);
    sender.once("destroyed", () => {
      ports.get(sender.id)?.dispose();
      ports.delete(sender.id);
    });
    return port;
  };

  ipcMain.handle(IpcChannel.rpcConnect, (event) => portFor(event.sender).connect());
  ipcMain.on(IpcChannel.rpcSend, (event, frame: string) => ports.get(event.sender.id)?.send(frame));
  ipcMain.on(IpcChannel.rendererError, (_event, report: RendererErrorReport) => {
    rendererLogger.error(`${report.origin ?? "renderer"}: ${report.message}`, report.stack);
  });
};

export const broadcastEngineStatus = (windows: readonly BrowserWindow[], status: EngineStatus) => {
  for (const window of windows) safeSend(window.webContents, IpcChannel.engineStatusChanged, status);
};
