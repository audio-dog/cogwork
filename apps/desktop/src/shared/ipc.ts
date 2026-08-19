import type { SchedulingState } from "@cogwork/contracts";

export type EngineStatus = "starting" | "running" | "adopted" | "stopped" | "failed";

export const IpcChannel = {
  getEngineStatus: "cogwork:get-engine-status",
  setEngineEnabled: "cogwork:set-engine-enabled",
  setSchedulingState: "cogwork:set-scheduling-state",
  engineStatusChanged: "cogwork:engine-status-changed",
  rpcConnect: "cogwork:rpc-connect",
  rpcSend: "cogwork:rpc-send",
  rpcData: "cogwork:rpc-data",
  rpcClosed: "cogwork:rpc-closed",
  rendererError: "cogwork:renderer-error",
} as const;

// A renderer-side failure (router error boundary, unhandled rejection) forwarded to `main`
// so it lands in the same node logs as engine and IPC failures.
export interface RendererErrorReport {
  readonly message: string;
  readonly stack?: string;
  readonly origin?: string;
}

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
  readonly setSchedulingState: (desired: SchedulingState) => void;
  readonly onEngineStatus: (listener: (status: EngineStatus) => void) => () => void;
  readonly rpc: DaemonRpcBridge;
  readonly reportError: (report: RendererErrorReport) => void;
}
