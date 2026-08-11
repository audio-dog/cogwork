import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge, ipcRenderer } from "electron";
import { type ClankerForgeBridge, IpcChannel } from "../shared/ipc";

const subscribe = <T>(channel: string, listener: (value: T) => void) => {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
};

const bridge: ClankerForgeBridge = {
  getEngineStatus: () => ipcRenderer.invoke(IpcChannel.getEngineStatus),
  setEngineEnabled: (enabled) => ipcRenderer.invoke(IpcChannel.setEngineEnabled, enabled),
  onEngineStatus: (listener) => subscribe(IpcChannel.engineStatusChanged, listener),
  rpc: {
    connect: () => ipcRenderer.invoke(IpcChannel.rpcConnect),
    send: (frame) => ipcRenderer.send(IpcChannel.rpcSend, frame),
    onData: (listener) => subscribe(IpcChannel.rpcData, listener),
    onClosed: (listener) => subscribe(IpcChannel.rpcClosed, listener),
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
