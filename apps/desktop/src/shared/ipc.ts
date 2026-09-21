import type { DesktopProcessHealthSample } from "@cogwork/contracts";
import type { ProcessProfileCapture as ProcessProfileCaptureValue } from "@cogwork/process-diagnostics";

export type ProcessProfileCapture = ProcessProfileCaptureValue;

export type EngineStatus = "starting" | "running" | "adopted" | "stopped" | "failed";

export const IpcChannel = {
  getEngineStatus: "cogwork:get-engine-status",
  setEngineEnabled: "cogwork:set-engine-enabled",
  engineStatusChanged: "cogwork:engine-status-changed",
  systemResumed: "cogwork:system-resumed",
  getWindowPreferences: "cogwork:get-window-preferences",
  getMainProcessHealth: "cogwork:get-main-process-health",
  setWindowPreferences: "cogwork:set-window-preferences",
  captureProcessProfile: "cogwork:capture-process-profile",
  rpcConnect: "cogwork:rpc-connect",
  rpcDisconnect: "cogwork:rpc-disconnect",
  rpcSend: "cogwork:rpc-send",
  rpcData: "cogwork:rpc-data",
  rpcClosed: "cogwork:rpc-closed",
  rendererError: "cogwork:renderer-error",
} as const;

// The window behavior the main process owns and persists across restarts. `closeToHide` on means
// closing the window hides it and leaves the engine running; off means closing quits the app.
export interface WindowPreferences {
  readonly closeToHide: boolean;
  readonly profiling: boolean;
}

// A renderer-side failure (router error boundary, unhandled rejection) forwarded to `main`
// so it lands in the same node logs as engine and IPC failures.
export interface RendererErrorReport {
  readonly message: string;
  readonly stack?: string;
  readonly origin?: string;
}

export type RpcSessionId = number;

export interface DaemonRpcData {
  readonly sessionId: RpcSessionId;
  readonly frame: Uint8Array;
}

export interface DaemonRpcClosed {
  readonly sessionId: RpcSessionId;
  readonly reason: string | null;
}

// Renderer relays RPC wire frames to `main`; it never opens the daemon socket (ADR 0009).
export interface DaemonRpcBridge {
  readonly connect: (sessionId: RpcSessionId) => Promise<void>;
  readonly disconnect: () => Promise<void>;
  readonly send: (frame: string) => void;
  readonly onData: (listener: (message: DaemonRpcData) => void) => () => void;
  readonly onClosed: (listener: (message: DaemonRpcClosed) => void) => () => void;
}

export interface CogworkBridge {
  readonly getEngineStatus: () => Promise<EngineStatus>;
  readonly setEngineEnabled: (enabled: boolean) => Promise<EngineStatus>;
  readonly onEngineStatus: (listener: (status: EngineStatus) => void) => () => void;
  readonly onSystemResume: (listener: () => void) => () => void;
  readonly getWindowPreferences: () => Promise<WindowPreferences>;
  readonly getProcessHealth: () => Promise<ReadonlyArray<DesktopProcessHealthSample>>;
  readonly setWindowPreferences: (preferences: Partial<WindowPreferences>) => Promise<WindowPreferences>;
  readonly captureProcessProfile: (capture: ProcessProfileCapture) => Promise<string>;
  readonly rpc: DaemonRpcBridge;
  readonly reportError: (report: RendererErrorReport) => void;
}
