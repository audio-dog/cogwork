import type { App } from "electron";

export const installShutdownBeforeQuit = (app: App, shutdown: () => Promise<void>) => {
  const state: { permitted: boolean; shutdown?: Promise<void> } = { permitted: false };
  const resume = () => {
    state.permitted = true;
    app.quit();
  };

  app.on("will-quit", (event) => {
    if (state.permitted) return;
    event.preventDefault();
    if (state.shutdown) return;
    state.shutdown = shutdown().then(resume, resume);
  });
};
