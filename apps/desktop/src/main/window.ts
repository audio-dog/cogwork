import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import { BrowserWindow, shell } from "electron";
import windowStateKeeper from "electron-window-state";
import icon from "../../resources/icon.png?asset";

export interface MainWindowDeps {
  readonly shouldQuit: () => boolean;
}

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
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  windowState.manage(window);

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
    event.preventDefault();
    window.hide();
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
};
