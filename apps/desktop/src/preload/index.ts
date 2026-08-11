import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge, ipcRenderer } from "electron";
import { type ClankerForgeBridge, type EngineStatus, IpcChannel } from "../shared/ipc";

const bridge: ClankerForgeBridge = {
  getDaemonStatus: () => ipcRenderer.invoke(IpcChannel.getDaemonStatus),
  getEngineStatus: () => ipcRenderer.invoke(IpcChannel.getEngineStatus),
  setEngineEnabled: (enabled) => ipcRenderer.invoke(IpcChannel.setEngineEnabled, enabled),
  onEngineStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: EngineStatus): void => listener(status);
    ipcRenderer.on(IpcChannel.engineStatusChanged, handler);
    return () => {
      ipcRenderer.removeListener(IpcChannel.engineStatusChanged, handler);
    };
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("clankerForge", bridge);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-expect-error (define in dts)
  window.electron = electronAPI;
  // @ts-expect-error (define in dts)
  window.clankerForge = bridge;
}
