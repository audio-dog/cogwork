import { spawn } from "node:child_process";
import { join } from "node:path";
import { electronApp, optimizer } from "@electron-toolkit/utils";
import { app, BrowserWindow } from "electron";
import { defaultSocketPath } from "./daemon-paths";
import { resolveEngineCommand } from "./engine-command";
import { EngineSupervisor } from "./engine-supervisor";
import { broadcastEngineStatus, registerIpc } from "./ipc";
import { engineLogger } from "./logger";
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
    nodeBinary: process.env.CLANKER_FORGE_NODE,
    engineEntry: process.env.CLANKER_FORGE_ENGINE_ENTRY,
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
    electronApp.setAppUserModelId("com.clanker-forge");
    app.on("browser-window-created", (_event, window) => optimizer.watchWindowShortcuts(window));

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
