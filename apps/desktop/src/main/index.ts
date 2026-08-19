import { spawn } from "node:child_process";
import { join } from "node:path";
import { electronApp, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow } from "electron";
import { defaultSocketPath } from "./daemon-paths";
import { resolveEngineCommand } from "./engine-command";
import { EngineSupervisor } from "./engine-supervisor";
import { broadcastEngineStatus, registerIpc } from "./ipc";
import { engineLogger, mainLogger } from "./logger";
import { isDaemonListening } from "./socket-probe";
import { createTray } from "./tray";
import { createMainWindow } from "./window";

const control = { quitting: false, engineStopped: false };

const showMainWindow = (): void => {
  const [window] = BrowserWindow.getAllWindows();
  if (!window) {
    createMainWindow({ shouldQuit: () => control.quitting });
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
};

const makeSupervisor = (): EngineSupervisor => {
  const socketPath = defaultSocketPath;
  const baseDir = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "..", "..");
  const command = resolveEngineCommand({
    socketPath,
    packaged: app.isPackaged,
    baseDir,
    nodeBinary: process.env.COGWORK_NODE,
    engineEntry: process.env.COGWORK_ENGINE_ENTRY,
  });

  const supervisor = new EngineSupervisor({
    command,
    socketPath,
    spawn: (engine) =>
      spawn(engine.command, [...engine.args], { cwd: engine.cwd, stdio: ["ignore", "pipe", "pipe"] }),
    probe: isDaemonListening,
    logger: engineLogger,
    onStatus: (status) => {
      engineLogger.info(`Engine status: ${status}`);
      broadcastEngineStatus(BrowserWindow.getAllWindows(), status);
    },
  });

  registerIpc({ socketPath, supervisor });
  return supervisor;
};

const bootstrap = (): void => {
  app.whenReady().then(async () => {
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

    const supervisor = makeSupervisor();

    createMainWindow({ shouldQuit: () => control.quitting });
    createTray({
      onShow: showMainWindow,
      onQuit: () => {
        control.quitting = true;
        app.quit();
      },
    });

    app.on("activate", showMainWindow);
    app.on("second-instance", showMainWindow);
    app.on("before-quit", () => {
      control.quitting = true;
    });
    app.on("will-quit", (event) => {
      if (control.engineStopped) return;
      event.preventDefault();
      supervisor.stop().finally(() => {
        control.engineStopped = true;
        app.quit();
      });
    });

    await supervisor.start();
  });
};

if (app.requestSingleInstanceLock()) {
  bootstrap();
} else {
  app.quit();
}
