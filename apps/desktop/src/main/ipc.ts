import { type BrowserWindow, ipcMain } from "electron";
import { type EngineStatus, IpcChannel } from "../shared/ipc";
import { getDaemonStatus } from "./daemon-rpc";
import type { EngineSupervisor } from "./engine-supervisor";

export interface IpcDeps {
  readonly socketPath: string;
  readonly supervisor: EngineSupervisor;
}

export const registerIpc = (deps: IpcDeps): void => {
  ipcMain.handle(IpcChannel.getDaemonStatus, () => getDaemonStatus(deps.socketPath));
  ipcMain.handle(IpcChannel.getEngineStatus, () => deps.supervisor.status);
};

export const broadcastEngineStatus = (windows: readonly BrowserWindow[], status: EngineStatus): void => {
  for (const window of windows) window.webContents.send(IpcChannel.engineStatusChanged, status);
};
