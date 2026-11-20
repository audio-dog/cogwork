import { join } from "node:path";

import { is } from "@electron-toolkit/utils";
import { BrowserWindow, shell } from "electron";
import windowStateKeeper from "electron-window-state";

import icon from "../../resources/icon.png?asset";
import { mainLogger } from "./logger";

export interface MainWindowDeps {
  readonly shouldQuit: () => boolean;
  // Read live on each close so a Settings toggle takes effect without recreating the window.
  readonly closeToHide: () => boolean;
  readonly requestQuit: () => void;
}

export const showMainWindow = (deps: MainWindowDeps) => {
  if (deps.shouldQuit()) return;
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) {
    createMainWindow(deps);
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
};

const loadRenderer = (window: BrowserWindow): void => {
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    window.loadFile(join(__dirname, "../renderer/index.html"));
  }
};

// A GPU/network-service crash disposes the render frame and leaves a white screen that a manual
// refresh can't recover, because the render process is gone. Reload it ourselves — but cap retries
// so a renderer that crashes on every load can't spin in a reload loop.
const maxReloadsPerWindow = 3;
const reloadCooldownMs = 30_000;

const installCrashRecovery = (window: BrowserWindow): void => {
  const reloads = { count: 0, firstAt: 0 };

  const reload = (why: string): void => {
    const now = Date.now();
    if (now - reloads.firstAt > reloadCooldownMs) {
      reloads.count = 0;
      reloads.firstAt = now;
    }
    if (reloads.count >= maxReloadsPerWindow) {
      mainLogger.error(
        `Renderer keeps failing (${why}); stopped auto-reloading after ${reloads.count} tries`,
      );
      return;
    }
    reloads.count += 1;
    mainLogger.warn(`Recovering renderer (${why}); reload ${reloads.count}/${maxReloadsPerWindow}`);
    loadRenderer(window);
  };

  window.webContents.on("render-process-gone", (_event, details) => {
    mainLogger.error(`Render process gone: ${details.reason} (exitCode ${details.exitCode})`);
    if (details.reason !== "clean-exit") reload(`render-process-gone: ${details.reason}`);
  });

  window.webContents.on("unresponsive", () => reload("unresponsive"));
};

export const createMainWindow = (deps: MainWindowDeps): BrowserWindow => {
  const windowState = windowStateKeeper({ defaultWidth: 1100, defaultHeight: 760 });

  const window = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === "linux" ? { icon } : {}),
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 14 } }
      : {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: { color: "#00000000", symbolColor: "#9ca3af", height: 44 },
        }),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  windowState.manage(window);
  installCrashRecovery(window);

  window.on("ready-to-show", () => window.show());

  window.webContents.setWindowOpenHandler((details) => {
    // Only hand real web links to the OS — never a file:// or custom-scheme url that shell.openExternal
    // would launch as a local handler.
    const protocol = URL.parse(details.url)?.protocol;
    if (protocol === "https:" || protocol === "http:") shell.openExternal(details.url);
    return { action: "deny" };
  });

  window.on("close", (event) => {
    if (deps.shouldQuit()) return;
    if (deps.closeToHide()) {
      event.preventDefault();
      window.hide();
      return;
    }
    // Close-to-hide is off: closing the window quits the app, which stops a spawned engine.
    event.preventDefault();
    deps.requestQuit();
  });

  loadRenderer(window);

  return window;
};
