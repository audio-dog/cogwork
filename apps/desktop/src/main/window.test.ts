import type { BrowserWindow, shell } from "electron";
import type windowStateKeeper from "electron-window-state";
import { beforeEach, expect, it, vi } from "vitest";

import type { mainLogger } from "./logger";
import type { MainWindowDeps } from "./window";

const electron = vi.hoisted(() => ({
  getAllWindows: vi.fn<typeof BrowserWindow.getAllWindows>(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: electron.getAllWindows },
  shell: { openExternal: vi.fn<typeof shell.openExternal>() },
}));

vi.mock("electron-window-state", () => ({ default: vi.fn<typeof windowStateKeeper>() }));
vi.mock("@electron-toolkit/utils", () => ({ is: { dev: false } }));
vi.mock("./logger", () => ({
  mainLogger: { error: vi.fn<typeof mainLogger.error>(), warn: vi.fn<typeof mainLogger.warn>() },
}));

import { showMainWindow } from "./window";

beforeEach(() => {
  electron.getAllWindows.mockClear();
});

it("does not show or create a window after quit starts", () => {
  showMainWindow({
    shouldQuit: () => true,
    closeToHide: () => false,
    requestQuit: vi.fn<MainWindowDeps["requestQuit"]>(),
  });

  expect(electron.getAllWindows).not.toHaveBeenCalled();
});
