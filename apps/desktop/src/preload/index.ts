import { electronAPI } from "@electron-toolkit/preload";
import { contextBridge, ipcRenderer } from "electron";
import { type CogworkBridge, IpcChannel } from "../shared/ipc";
import { kibibytesToBytes } from "../shared/process-health";

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
  onEngineStatus: (listener) => subscribe(IpcChannel.engineStatusChanged, listener),
  onSystemResume: (listener) => subscribe(IpcChannel.systemResumed, listener),
  getWindowPreferences: () => ipcRenderer.invoke(IpcChannel.getWindowPreferences),
  getProcessHealth: async () => {
    const [main, memory] = await Promise.all([
      ipcRenderer.invoke(IpcChannel.getMainProcessHealth),
      process.getProcessMemoryInfo(),
    ]);
    const heap = process.getHeapStatistics();
    return [
      main,
      {
        process: "renderer",
        sampledAtMillis: Date.now(),
        heapUsedBytes: kibibytesToBytes(heap.usedHeapSize),
        heapLimitBytes: kibibytesToBytes(heap.heapSizeLimit),
        privateBytes: kibibytesToBytes(memory.private),
      },
    ];
  },
  setWindowPreferences: (preferences) => ipcRenderer.invoke(IpcChannel.setWindowPreferences, preferences),
  captureProcessProfile: (capture) => ipcRenderer.invoke(IpcChannel.captureProcessProfile, capture),
  chooseFolder: () => ipcRenderer.invoke(IpcChannel.chooseFolder),
  notifications: {
    enable: () => ipcRenderer.invoke(IpcChannel.enableDesktopNotifications),
    sync: (requests) => ipcRenderer.invoke(IpcChannel.syncDesktopNotifications, requests),
    getStatus: () => ipcRenderer.invoke(IpcChannel.getDesktopNotificationStatus),
    onStatus: (listener) => subscribe(IpcChannel.desktopNotificationStatusChanged, listener),
    onNavigation: (listener) => subscribe(IpcChannel.desktopNotificationNavigation, listener),
    takeNavigation: () => ipcRenderer.invoke(IpcChannel.takeDesktopNotificationNavigation),
    openSettings: () => ipcRenderer.invoke(IpcChannel.openNotificationSettings),
  },
  rpc: {
    connect: (sessionId) => ipcRenderer.invoke(IpcChannel.rpcConnect, sessionId),
    disconnect: () => ipcRenderer.invoke(IpcChannel.rpcDisconnect),
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
