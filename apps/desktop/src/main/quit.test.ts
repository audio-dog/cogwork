import { expect, it, vi } from "vitest";
import { installQuitHandler, type QuitEvent, type QuitHandler } from "./quit";

const makeApp = () => {
  const callbacks: { willQuit?: QuitHandler } = {};
  const app = {
    on: (_event: "will-quit", handler: QuitHandler) => {
      callbacks.willQuit = handler;
    },
    quit: vi.fn(),
  };
  const requestQuit = () => {
    const event: QuitEvent = { preventDefault: vi.fn() };
    const handler = callbacks.willQuit;
    if (!handler) throw new Error("Quit handler was not installed");
    handler(event);
    return event;
  };
  return { app, requestQuit };
};

it("waits for one shutdown before permitting quit", async () => {
  const shutdown = Promise.withResolvers<void>();
  const dispose = vi.fn(() => shutdown.promise);
  const { app, requestQuit } = makeApp();
  installQuitHandler(app, dispose);

  const first = requestQuit();
  const repeated = requestQuit();

  expect(first.preventDefault).toHaveBeenCalledOnce();
  expect(repeated.preventDefault).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledOnce();
  expect(app.quit).not.toHaveBeenCalled();

  shutdown.resolve();
  await shutdown.promise;
  await Promise.resolve();

  expect(app.quit).toHaveBeenCalledOnce();

  const resumed = requestQuit();
  expect(resumed.preventDefault).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledOnce();
  expect(app.quit).toHaveBeenCalledOnce();
});

it("resumes quit when shutdown fails", async () => {
  const dispose = vi.fn(() => Promise.reject(new Error("shutdown failed")));
  const { app, requestQuit } = makeApp();
  installQuitHandler(app, dispose);

  const event = requestQuit();

  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledOnce();

  await Promise.resolve();
  await Promise.resolve();

  expect(app.quit).toHaveBeenCalledOnce();
});
