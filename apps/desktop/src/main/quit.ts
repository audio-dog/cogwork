export interface QuitEvent {
  preventDefault(): void;
}

export type QuitHandler = (event: QuitEvent) => void;

interface QuitApp {
  on(event: "will-quit", handler: QuitHandler): unknown;
  quit(): void;
}

interface QuitState {
  permitted: boolean;
  shutdown?: Promise<void>;
}

export const installQuitHandler = (app: QuitApp, dispose: () => Promise<void>) => {
  const state: QuitState = { permitted: false };
  const resume = () => {
    state.permitted = true;
    app.quit();
  };

  app.on("will-quit", (event) => {
    if (state.permitted) return;
    event.preventDefault();
    if (state.shutdown) return;
    state.shutdown = dispose().then(resume, resume);
  });
};
