import { type BrowserWindow, ipcMain, type WebContents } from "electron";
import { type EngineStatus, IpcChannel } from "../shared/ipc";
import { createDaemonBridgePort, type DaemonBridgePort } from "./daemon-bridge";
import type { EngineSupervisor } from "./engine-supervisor";

export interface IpcDeps {
  readonly socketPath: string;
  readonly supervisor: EngineSupervisor;
}

export const registerIpc = (deps: IpcDeps) => {
  ipcMain.handle(IpcChannel.getEngineStatus, () => deps.supervisor.status);
  ipcMain.handle(IpcChannel.setEngineEnabled, async (_event, enabled: boolean) => {
    await (enabled ? deps.supervisor.start() : deps.supervisor.stop());
    return deps.supervisor.status;
  });

  const ports = new Map<number, DaemonBridgePort>();

  const portFor = (sender: WebContents): DaemonBridgePort => {
    const existing = ports.get(sender.id);
    if (existing) return existing;
    const port = createDaemonBridgePort(deps.socketPath, {
      onData: (frame) => {
        if (!sender.isDestroyed()) sender.send(IpcChannel.rpcData, frame);
      },
      onClosed: (reason) => {
        if (!sender.isDestroyed()) sender.send(IpcChannel.rpcClosed, reason);
      },
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
};

export const broadcastEngineStatus = (windows: readonly BrowserWindow[], status: EngineStatus) => {
  for (const window of windows) window.webContents.send(IpcChannel.engineStatusChanged, status);
};
