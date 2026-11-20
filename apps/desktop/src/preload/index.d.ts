import type { ElectronAPI } from "@electron-toolkit/preload";

import type { CogworkBridge } from "../shared/ipc";

declare global {
  interface Window {
    electron: ElectronAPI;
    cogwork: CogworkBridge;
  }
}
