import { beforeEach, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  getAllWindows: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: electron.getAllWindows },
  shell: { openExternal: vi.fn() },
}));

vi.mock("electron-window-state", () => ({ default: vi.fn() }));
vi.mock("@electron-toolkit/utils", () => ({ is: { dev: false } }));
vi.mock("./logger", () => ({
  mainLogger: { error: vi.fn(), warn: vi.fn() },
}));

import { showMainWindow } from "./window";

beforeEach(() => {
  electron.getAllWindows.mockClear();
});

it("does not show or create a window after quit starts", () => {
  showMainWindow({
    shouldQuit: () => true,
    closeToHide: () => false,
    requestQuit: vi.fn(),
  });

  expect(electron.getAllWindows).not.toHaveBeenCalled();
});
