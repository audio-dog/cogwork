export type EngineStatus = "starting" | "running" | "adopted" | "stopped" | "failed";

export const IpcChannel = {
  getEngineStatus: "cogwork:get-engine-status",
  setEngineEnabled: "cogwork:set-engine-enabled",
  engineStatusChanged: "cogwork:engine-status-changed",
  rpcConnect: "cogwork:rpc-connect",
  rpcSend: "cogwork:rpc-send",
  rpcData: "cogwork:rpc-data",
  rpcClosed: "cogwork:rpc-closed",
} as const;

// Renderer relays RPC wire frames to `main`; it never opens the daemon socket (ADR 0009).
export interface DaemonRpcBridge {
  readonly connect: () => Promise<void>;
  readonly send: (frame: string) => void;
  readonly onData: (listener: (frame: Uint8Array) => void) => () => void;
  readonly onClosed: (listener: (reason: string | null) => void) => () => void;
}

export interface CogworkBridge {
  readonly getEngineStatus: () => Promise<EngineStatus>;
  readonly setEngineEnabled: (enabled: boolean) => Promise<EngineStatus>;
  readonly onEngineStatus: (listener: (status: EngineStatus) => void) => () => void;
  readonly rpc: DaemonRpcBridge;
}
