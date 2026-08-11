export type EngineStatus = "starting" | "running" | "adopted" | "stopped" | "failed";

export const IpcChannel = {
  getEngineStatus: "clanker-forge:get-engine-status",
  setEngineEnabled: "clanker-forge:set-engine-enabled",
  engineStatusChanged: "clanker-forge:engine-status-changed",
  rpcConnect: "clanker-forge:rpc-connect",
  rpcSend: "clanker-forge:rpc-send",
  rpcData: "clanker-forge:rpc-data",
  rpcClosed: "clanker-forge:rpc-closed",
} as const;

// Renderer relays RPC wire frames to `main`; it never opens the daemon socket (ADR 0009).
export interface DaemonRpcBridge {
  readonly connect: () => Promise<void>;
  readonly send: (frame: string) => void;
  readonly onData: (listener: (frame: Uint8Array) => void) => () => void;
  readonly onClosed: (listener: (reason: string | null) => void) => () => void;
}

export interface ClankerForgeBridge {
  readonly getEngineStatus: () => Promise<EngineStatus>;
  readonly setEngineEnabled: (enabled: boolean) => Promise<EngineStatus>;
  readonly onEngineStatus: (listener: (status: EngineStatus) => void) => () => void;
  readonly rpc: DaemonRpcBridge;
}
