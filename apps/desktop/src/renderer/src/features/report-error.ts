import type { RendererErrorReport } from "../../../shared/ipc";

// Forward a renderer-side failure to `main` so it lands in the node logs alongside engine and IPC
// errors. `window.cogwork` is missing only if the preload failed to load, so guard the call.
export const reportRendererError = (error: unknown, origin: string): void => {
  const report: RendererErrorReport = {
    origin,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
  console.error(`[${origin}]`, error);
  window.cogwork?.reportError(report);
};
