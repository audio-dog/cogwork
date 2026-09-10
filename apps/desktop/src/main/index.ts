import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeLiveProcessProfiler, type ProcessProfileInput } from "@cogwork/process-diagnostics";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { electronApp, optimizer } from "@electron-toolkit/utils";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Stream, SubscriptionRef } from "effect";
import { app, BrowserWindow, crashReporter } from "electron";
import { defaultSocketPath } from "./daemon-paths";
import { resolveDesktopEnvironment } from "./desktop-environment";
import { resolveEngineCommand, resolveEngineShutdownBudgets } from "./engine-command";
import { EngineSupervisor, layer as engineSupervisorLayer } from "./engine-supervisor";
import { broadcastEngineStatus, registerIpc } from "./ipc";
import { engineLoggerLayer, mainLogger } from "./logger";
import { installShutdownBeforeQuit } from "./quit";
import { isDaemonListening } from "./socket-probe";
import { createTray } from "./tray";
import { waitForDaemonListening } from "./wait-for-socket";
import { type MainWindowDeps, showMainWindow } from "./window";
import { createWindowPreferencesStore } from "./window-preferences";

const control = { quitting: false };

const requestQuit = () => {
  control.quitting = true;
  app.quit();
};

const windowPreferences = createWindowPreferencesStore();
const diagnosticsDirectory = dirname(defaultSocketPath);

const windowDeps: MainWindowDeps = {
  shouldQuit: () => control.quitting,
  closeToHide: () => windowPreferences.get().closeToHide,
  requestQuit,
};

const showWindow = () => showMainWindow(windowDeps);

const makeSupervisorLayer = (environment: NodeJS.ProcessEnv) => {
  const socketPath = defaultSocketPath;
  const baseDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "..", "..");
  const shutdown = resolveEngineShutdownBudgets();
  return engineSupervisorLayer({
    command: () =>
      resolveEngineCommand({
        socketPath,
        packaged: app.isPackaged,
        baseDir,
        nodeBinary: process.env.COGWORK_NODE,
        engineEntry: process.env.COGWORK_ENGINE_ENTRY,
        drainGraceSeconds: shutdown.drainGraceSeconds,
        profiling: windowPreferences.get().profiling,
      }),
    environment,
    socketPath,
    probe: isDaemonListening,
    awaitReachable: waitForDaemonListening,
    terminateTimeout: shutdown.terminateTimeoutMillis,
  });
};

const captureMainProfile = (input: ProcessProfileInput) =>
  makeLiveProcessProfiler().pipe(
    Effect.flatMap((profiler) => profiler.capture(input)),
    Effect.provide(NodeServices.layer),
  );

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

const childProcessSpawnerLayer = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
);

const makeRuntimeLayer = (environment: NodeJS.ProcessEnv) => {
  const supervisor = makeSupervisorLayer(environment).pipe(Layer.provide(childProcessSpawnerLayer));
  const publisher = engineStatusPublisherLayer.pipe(
    Layer.provide(supervisor),
    Layer.provide(engineLoggerLayer),
  );
  return Layer.mergeAll(supervisor, publisher, engineLoggerLayer);
};

const mainLayer = Layer.unwrap(
  resolveDesktopEnvironment({ inherited: process.env, platform: process.platform }).pipe(
    Effect.provide(childProcessSpawnerLayer),
    Effect.provide(engineLoggerLayer),
    Effect.map(makeRuntimeLayer),
  ),
);

const bootstrap = () => {
  mkdirSync(diagnosticsDirectory, { recursive: true, mode: 0o700 });
  chmodSync(diagnosticsDirectory, 0o700);
  crashReporter.start({ uploadToServer: false });
  app.whenReady().then(async () => {
    const runtime = ManagedRuntime.make(mainLayer);
    app.on("before-quit", () => {
      control.quitting = true;
    });
    installShutdownBeforeQuit(app, () => runtime.dispose());
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

    const supervisor = await runtime.runPromise(EngineSupervisor);
    registerIpc({
      socketPath: defaultSocketPath,
      supervisor,
      windowPreferences,
      diagnosticsDirectory,
      captureMainProfile,
      isTrustedSender: (sender) =>
        BrowserWindow.getAllWindows().some((window) => window.webContents === sender),
      runtime,
    });

    const startExit = await runtime.runPromiseExit(supervisor.start);
    if (Exit.isFailure(startExit) && Cause.hasInterruptsOnly(startExit.cause)) return;
    if (Exit.isFailure(startExit)) mainLogger.error("Engine startup failed", startExit.cause);
    const status = runtime.runSync(SubscriptionRef.get(supervisor.status));
    if (status === "adopted" && windowPreferences.get().profiling) {
      windowPreferences.set({ profiling: false });
    }

    showWindow();
    createTray({
      onShow: showWindow,
      onQuit: requestQuit,
    });

    app.on("activate", showWindow);
    app.on("second-instance", showWindow);
  });
};

if (app.requestSingleInstanceLock()) {
  bootstrap();
} else {
  app.quit();
}
