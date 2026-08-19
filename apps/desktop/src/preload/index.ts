import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge, ipcRenderer } from "electron";
import { type CogworkBridge, IpcChannel } from "../shared/ipc";

const subscribe = <T>(channel: string, listener: (value: T) => void) => {
  const handler = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
};

const bridge: CogworkBridge = {
  getEngineStatus: () => ipcRenderer.invoke(IpcChannel.getEngineStatus),
  setEngineEnabled: (enabled) => ipcRenderer.invoke(IpcChannel.setEngineEnabled, enabled),
  setSchedulingState: (desired) => ipcRenderer.send(IpcChannel.setSchedulingState, desired),
  onEngineStatus: (listener) => subscribe(IpcChannel.engineStatusChanged, listener),
  rpc: {
    connect: () => ipcRenderer.invoke(IpcChannel.rpcConnect),
    send: (frame) => ipcRenderer.send(IpcChannel.rpcSend, frame),
    onData: (listener) => subscribe(IpcChannel.rpcData, listener),
    onClosed: (listener) => subscribe(IpcChannel.rpcClosed, listener),
  },
  reportError: (report) => ipcRenderer.send(IpcChannel.rendererError, report),
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("cogwork", bridge);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-expect-error (define in dts)
  window.electron = electronAPI;
  // @ts-expect-error (define in dts)
  window.cogwork = bridge;
}
