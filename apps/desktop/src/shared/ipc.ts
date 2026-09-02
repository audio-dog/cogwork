import type { ProcessProfileCapture as ProcessProfileCaptureValue } from "@cogwork/process-diagnostics";

export type ProcessProfileCapture = ProcessProfileCaptureValue;

export type EngineStatus = "starting" | "running" | "adopted" | "stopped" | "failed";

export const IpcChannel = {
  getEngineStatus: "cogwork:get-engine-status",
  setEngineEnabled: "cogwork:set-engine-enabled",
  engineStatusChanged: "cogwork:engine-status-changed",
  getWindowPreferences: "cogwork:get-window-preferences",
  setWindowPreferences: "cogwork:set-window-preferences",
  captureProcessProfile: "cogwork:capture-process-profile",
  rpcConnect: "cogwork:rpc-connect",
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
  readonly getWindowPreferences: () => Promise<WindowPreferences>;
  readonly setWindowPreferences: (preferences: Partial<WindowPreferences>) => Promise<WindowPreferences>;
  readonly captureProcessProfile: (capture: ProcessProfileCapture) => Promise<string>;
  readonly rpc: DaemonRpcBridge;
  readonly reportError: (report: RendererErrorReport) => void;
}
