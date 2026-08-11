import type { DaemonStatus } from "@clanker-forge/contracts";

export type EngineStatus = "starting" | "running" | "adopted" | "stopped" | "failed";

export type DaemonStatusResult =
  | { readonly ok: true; readonly status: DaemonStatus }
  | { readonly ok: false; readonly message: string };

export const IpcChannel = {
  getDaemonStatus: "clanker-forge:get-daemon-status",
  getEngineStatus: "clanker-forge:get-engine-status",
  engineStatusChanged: "clanker-forge:engine-status-changed",
} as const;

export interface ClankerForgeBridge {
  readonly getDaemonStatus: () => Promise<DaemonStatusResult>;
  readonly getEngineStatus: () => Promise<EngineStatus>;
  readonly onEngineStatus: (listener: (status: EngineStatus) => void) => () => void;
}
