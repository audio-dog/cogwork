import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { makeLiveProcessProfiler, type ProcessProfileInput } from "@cogwork/process-diagnostics";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { electronApp, optimizer } from "@electron-toolkit/utils";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Stream, SubscriptionRef } from "effect";
import { app, BrowserWindow, crashReporter, dialog, Notification, powerMonitor, shell } from "electron";

import appIdentity from "../../app-identity.json";
import { defaultSocketPath } from "./daemon-paths";
import { resolveDesktopEnvironment } from "./desktop-environment";
import {
  createDesktopNotifications,
  type DesktopNotifications,
  notificationIdFromActivation,
} from "./desktop-notifications";
import { resolveEngineCommand, resolveEngineShutdownBudgets } from "./engine-command";
import { EngineSupervisor, layer as engineSupervisorLayer } from "./engine-supervisor";
import {
  broadcastDesktopNotificationNavigation,
  broadcastDesktopNotificationStatus,
  broadcastEngineStatus,
  broadcastSystemResume,
  registerIpc,
} from "./ipc";
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

const notificationSettingsUrls: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
  win32: "ms-settings:notifications",
};

const launchIdentifier = (launchInfo: unknown) => {
  if (typeof launchInfo !== "object" || launchInfo === null || !("identifier" in launchInfo)) return null;
  return typeof launchInfo.identifier === "string" ? launchInfo.identifier : null;
};

const cogworkUrls = (values: readonly string[]) => values.filter((value) => value.startsWith("cogwork://"));

const shellState: {
  notifications: DesktopNotifications | null;
  launchIdentifier: string | null;
  pendingUrls: string[];
} = { notifications: null, launchIdentifier: null, pendingUrls: [] };

const acceptCogworkUrl = (url: string) => {
  const notifications = shellState.notifications;
  if (notifications) return notifications.openUrl(url);
  shellState.pendingUrls.push(url);
};

const makeDesktopNotifications = () =>
  createDesktopNotifications({
    create: (request) => new Notification(request),
    getHistory: () => (process.platform === "darwin" ? Notification.getHistory() : Promise.resolve([])),
    isSupported: Notification.isSupported,
    remove: (id) => {
      if (process.platform === "darwin") Notification.remove(id);
    },
    registerActivation: (listener) => {
      if (process.platform === "win32") {
        Notification.handleActivation(({ arguments: activation }) =>
          listener(notificationIdFromActivation(activation)),
        );
      }
    },
    showWindow,
    navigate: () => broadcastDesktopNotificationNavigation(BrowserWindow.getAllWindows()),
    publishStatus: (status) => broadcastDesktopNotificationStatus(BrowserWindow.getAllWindows(), status),
    logFailure: (message) => mainLogger.error(`OS notification failed: ${message}`),
    openSettings: async () => {
      const url = notificationSettingsUrls[process.platform];
      if (!url) return false;
      await shell.openExternal(url);
      return true;
    },
    launchIdentifier: shellState.launchIdentifier,
  });

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
        performanceWorkspace: process.env.COGWORK_PERFORMANCE_WORKSPACE,
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

const systemResumePublisherLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.sync(() => {
      const publish = () => broadcastSystemResume(BrowserWindow.getAllWindows());
      powerMonitor.on("resume", publish);
      return publish;
    }),
    (publish) => Effect.sync(() => powerMonitor.off("resume", publish)),
  ),
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
  return Layer.mergeAll(supervisor, publisher, systemResumePublisherLayer, engineLoggerLayer);
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
  app.setAsDefaultProtocolClient("cogwork");
  app.once("ready", (_event, launchInfo: unknown) => {
    shellState.launchIdentifier = launchIdentifier(launchInfo);
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    acceptCogworkUrl(url);
  });
  app.whenReady().then(async () => {
    const runtime = ManagedRuntime.make(mainLayer);
    app.on("before-quit", () => {
      control.quitting = true;
      shellState.notifications?.closeAll();
    });
    installShutdownBeforeQuit(app, () => runtime.dispose());
    electronApp.setAppUserModelId(appIdentity.appId);
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

    const notifications = makeDesktopNotifications();
    shellState.notifications = notifications;
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
      notifications,
      chooseFolder: async (sender) => {
        const options = { properties: ["openDirectory" as const] };
        const window = BrowserWindow.fromWebContents(sender);
        const result = window
          ? await dialog.showOpenDialog(window, options)
          : await dialog.showOpenDialog(options);
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
    });

    const startExit = await runtime.runPromiseExit(supervisor.start);
    if (Exit.isFailure(startExit) && Cause.hasInterruptsOnly(startExit.cause)) return;
    if (Exit.isFailure(startExit)) mainLogger.error("Engine startup failed", startExit.cause);
    const status = runtime.runSync(SubscriptionRef.get(supervisor.status));
    if (status === "adopted" && windowPreferences.get().profiling) {
      windowPreferences.set({ profiling: false });
    }

    showWindow();
    [...shellState.pendingUrls, ...cogworkUrls(process.argv)].forEach((url) => {
      notifications.openUrl(url);
    });
    shellState.pendingUrls.length = 0;
    createTray({
      onShow: showWindow,
      onQuit: requestQuit,
    });

    app.on("activate", showWindow);
    app.on("second-instance", (_event, commandLine) => {
      const urls = cogworkUrls(commandLine);
      if (urls.length === 0) {
        showWindow();
        return;
      }
      urls.forEach((url) => {
        notifications.openUrl(url);
      });
    });
  });
};

if (app.requestSingleInstanceLock()) {
  bootstrap();
} else {
  app.quit();
}
