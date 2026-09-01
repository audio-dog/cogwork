import { spawn } from "node:child_process";
import { join } from "node:path";
import { electronApp, optimizer } from "@electron-toolkit/utils";
import { Cause, Effect, Layer, ManagedRuntime, Stream, SubscriptionRef } from "effect";
import { app, BrowserWindow } from "electron";
import { defaultSocketPath } from "./daemon-paths";
import { resolveEngineCommand } from "./engine-command";
import { EngineSupervisor } from "./engine-supervisor";
import { broadcastEngineStatus, registerIpc } from "./ipc";
import { engineLoggerLayer, mainLogger } from "./logger";
import { installShutdownBeforeQuit } from "./quit";
import { isDaemonListening } from "./socket-probe";
import { createTray } from "./tray";
import { waitForDaemonListening } from "./wait-for-socket";
import { createMainWindow, type MainWindowDeps } from "./window";
import { createWindowPreferencesStore } from "./window-preferences";

const control = { quitting: false };

const requestQuit = () => {
  control.quitting = true;
  app.quit();
};

const windowPreferences = createWindowPreferencesStore();

const windowDeps: MainWindowDeps = {
  shouldQuit: () => control.quitting,
  closeToHide: () => windowPreferences.get().closeToHide,
  requestQuit,
};

const showMainWindow = () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) {
    createMainWindow(windowDeps);
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
};

const makeSupervisorLayer = () => {
  const socketPath = defaultSocketPath;
  const baseDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "..", "..");
  const command = resolveEngineCommand({
    socketPath,
    packaged: app.isPackaged,
    baseDir,
    nodeBinary: process.env.COGWORK_NODE,
    engineEntry: process.env.COGWORK_ENGINE_ENTRY,
  });

  return EngineSupervisor.layer({
    command,
    socketPath,
    spawn: (engine) =>
      spawn(engine.command, [...engine.args], { cwd: engine.cwd, stdio: ["ignore", "pipe", "pipe"] }),
    probe: isDaemonListening,
    awaitReachable: waitForDaemonListening,
    terminateTimeout: command.terminateTimeoutMillis,
  });
};

const publishEngineStatus = Effect.fn("DesktopMain.publishEngineStatus")(function* (
  status: Parameters<typeof broadcastEngineStatus>[1],
) {
  yield* Effect.logInfo("Engine status changed", { status });
  yield* Effect.sync(() => broadcastEngineStatus(BrowserWindow.getAllWindows(), status));
});

const engineStatusPublisherLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const supervisor = yield* EngineSupervisor;
    yield* SubscriptionRef.changes(supervisor.status).pipe(
      Stream.runForEach(publishEngineStatus),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logError("Engine status publisher failed", { cause }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  }),
);

const makeMainLayer = () => {
  const supervisor = makeSupervisorLayer();
  const publisher = engineStatusPublisherLayer.pipe(
    Layer.provide(supervisor),
    Layer.provide(engineLoggerLayer),
  );
  return Layer.mergeAll(supervisor, publisher, engineLoggerLayer);
};

const bootstrap = () => {
  app.whenReady().then(async () => {
    const runtime = ManagedRuntime.make(makeMainLayer());
    electronApp.setAppUserModelId("com.cogwork");
    app.on("browser-window-created", (_event, window) => optimizer.watchWindowShortcuts(window));

    // GPU/utility/network-service crashes (the `exit_code=15` that starts the white-screen cascade)
    // surface here rather than only on stderr, so they land in the same node logs as everything else.
    app.on("child-process-gone", (_event, details) => {
      const label = details.name ?? details.serviceName ?? details.type;
      mainLogger.error(`Child process gone: ${label} — ${details.reason} (exitCode ${details.exitCode})`);
    });
    app.on("render-process-gone", (_event, _contents, details) => {
      mainLogger.error(`Render process gone: ${details.reason} (exitCode ${details.exitCode})`);
    });

    const supervisor = runtime.runSync(EngineSupervisor);
    registerIpc({ socketPath: defaultSocketPath, supervisor, windowPreferences, runtime });

    createMainWindow(windowDeps);
    createTray({
      onShow: showMainWindow,
      onQuit: requestQuit,
    });

    app.on("activate", showMainWindow);
    app.on("second-instance", showMainWindow);
    app.on("before-quit", () => {
      control.quitting = true;
    });
    installShutdownBeforeQuit(app, () => runtime.dispose());

    await runtime.runPromise(supervisor.start);
  });
};

if (app.requestSingleInstanceLock()) {
  bootstrap();
} else {
  app.quit();
}
