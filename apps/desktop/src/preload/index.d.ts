import type { ElectronAPI } from "@electron-toolkit/preload";
import type { ClankerForgeBridge } from "../shared/ipc";

declare global {
  interface Window {
    electron: ElectronAPI;
    clankerForge: ClankerForgeBridge;
  }
}
