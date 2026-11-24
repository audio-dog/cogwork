import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, ManagedRuntime, SubscriptionRef } from "effect";
import type { WebContents } from "electron";
import { afterEach, expect, it, vi } from "vitest";

import { type EngineStatus, IpcChannel, type WindowPreferences } from "../shared/ipc";
import type { DesktopNotifications } from "./desktop-notifications";
import { EngineSupervisor, type EngineSupervisorService } from "./engine-supervisor";
import type { mainLogger, rendererLogger } from "./logger";
import type { WindowPreferencesStore } from "./window-preferences";

type IpcHandler = (...args: readonly unknown[]) => unknown;

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  listeners: new Map<string, IpcHandler>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => ipc.handlers.set(channel, handler),
    on: (channel: string, listener: IpcHandler) => ipc.listeners.set(channel, listener),
  },
}));

vi.mock("./logger", () => ({
  mainLogger: { warn: vi.fn<typeof mainLogger.warn>() },
  rendererLogger: { error: vi.fn<typeof rendererLogger.error>() },
}));

import { type IpcDeps, registerIpc } from "./ipc";

class FakeSender extends EventEmitter {
  readonly id = 1;
  readonly send = vi.fn<WebContents["send"]>();

  isDestroyed() {
    return false;
  }
}

const supervisor: EngineSupervisorService = {
  status: Effect.runSync(SubscriptionRef.make<EngineStatus>("adopted")),
  start: Effect.void,
  stop: Effect.void,
  captureProfile: () => Effect.succeed("/diagnostics/engine.heapsnapshot"),
};

const windowPreferences = {
  get: () => ({ closeToHide: true, profiling: false }),
  set: (preferences: { readonly closeToHide?: boolean; readonly profiling?: boolean }) => ({
    closeToHide: preferences.closeToHide ?? true,
    profiling: preferences.profiling ?? false,
  }),
};

const captureMainProfile = () => Effect.succeed("/diagnostics/main.heapsnapshot");

const makeRuntime = () => ManagedRuntime.make(Layer.succeed(EngineSupervisor, supervisor));

const notifications = {
  enable: vi.fn<DesktopNotifications["enable"]>(async () => ({ _tag: "ready" })),
  sync: vi.fn<DesktopNotifications["sync"]>(async () => ({ _tag: "ready" })),
  getStatus: vi.fn<DesktopNotifications["getStatus"]>(() => ({ _tag: "inactive" })),
  takeNavigation: vi.fn<DesktopNotifications["takeNavigation"]>(() => null),
  openSettings: vi.fn<DesktopNotifications["openSettings"]>(async () => true),
  openUrl: vi.fn<DesktopNotifications["openUrl"]>(),
  closeAll: vi.fn<DesktopNotifications["closeAll"]>(),
};

const chooseFolder = vi.fn<IpcDeps["chooseFolder"]>(async () => "/Users/taylor/sites/cogwork");

const deps = (socketPath: string, runtime: ReturnType<typeof makeRuntime>) => ({
  socketPath,
  supervisor,
  windowPreferences,
  diagnosticsDirectory: "/diagnostics",
  captureMainProfile,
  isTrustedSender: () => true,
  runtime,
  notifications,
  chooseFolder,
});

const listen = (server: net.Server, socketPath: string) =>
  new Promise<void>((resolve) => server.listen(socketPath, resolve));

const closeServer = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

afterEach(() => {
  ipc.handlers.clear();
  ipc.listeners.clear();
});

it("closes a renderer's socket when the renderer is destroyed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-ipc-"));
  const socketPath = join(dir, "daemon.sock");
  const accepted = Promise.withResolvers<net.Socket>();
  const closed = Promise.withResolvers<void>();
  const server = net.createServer((socket) => {
    accepted.resolve(socket);
    socket.once("close", () => closed.resolve());
  });
  await listen(server, socketPath);
  const runtime = makeRuntime();
  const sender = new FakeSender();

  try {
    registerIpc(deps(socketPath, runtime));
    const connect = ipc.handlers.get(IpcChannel.rpcConnect);
    if (!connect) throw new Error("RPC connect handler was not registered");

    await connect({ sender }, 1);
    await accepted.promise;
    sender.emit("destroyed");
    await closed.promise;

    expect((await accepted.promise).destroyed).toBe(true);
  } finally {
    await runtime.dispose();
    await closeServer(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

// Real `ipcMain.handle` structured-clones the resolved value to send it to the renderer; the
// mocked one above does not, so a non-cloneable value (an Effect port, a function) passes every
// other test here yet rejects at runtime with "An object could not be cloned".
it("resolves connect with a value Electron can clone across IPC", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-ipc-"));
  const socketPath = join(dir, "daemon.sock");
  const server = net.createServer();
  await listen(server, socketPath);
  const runtime = makeRuntime();
  const sender = new FakeSender();

  try {
    registerIpc(deps(socketPath, runtime));
    const connect = ipc.handlers.get(IpcChannel.rpcConnect);
    if (!connect) throw new Error("RPC connect handler was not registered");

    const resolved = await connect({ sender }, 1);

    expect(() => structuredClone(resolved)).not.toThrow();
  } finally {
    await runtime.dispose();
    await closeServer(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

it("rejects notification writes from an untrusted renderer", async () => {
  const runtime = makeRuntime();
  const sender = new FakeSender();
  notifications.sync.mockClear();

  try {
    registerIpc({ ...deps("/tmp/test.sock", runtime), isTrustedSender: () => false });
    const sync = ipc.handlers.get(IpcChannel.syncDesktopNotifications);
    if (!sync) throw new Error("Notification sync handler was not registered");

    await sync({ sender }, [
      { id: "issue:acme:818", focus: "issue:acme:818", title: "Needs you", body: "Review" },
    ]);

    expect(notifications.sync).not.toHaveBeenCalled();
  } finally {
    await runtime.dispose();
  }
});

it("opens no folder dialog for an untrusted renderer", async () => {
  const runtime = makeRuntime();
  const sender = new FakeSender();
  chooseFolder.mockClear();

  try {
    registerIpc({ ...deps("/tmp/test.sock", runtime), isTrustedSender: () => false });
    const choose = ipc.handlers.get(IpcChannel.chooseFolder);
    if (!choose) throw new Error("Folder handler was not registered");

    expect(await choose({ sender })).toBeNull();
    expect(chooseFolder).not.toHaveBeenCalled();
  } finally {
    await runtime.dispose();
  }
});

it("forwards bounded notification requests from the trusted renderer", async () => {
  const runtime = makeRuntime();
  const sender = new FakeSender();
  notifications.enable.mockClear();
  notifications.sync.mockClear();

  try {
    registerIpc(deps("/tmp/test.sock", runtime));
    const enable = ipc.handlers.get(IpcChannel.enableDesktopNotifications);
    const sync = ipc.handlers.get(IpcChannel.syncDesktopNotifications);
    if (!enable || !sync) throw new Error("Notification handlers were not registered");
    const request = {
      id: "issue:acme:818",
      focus: "issue:acme:818",
      title: "Needs you",
      body: "Review",
    };

    await enable({ sender });
    await sync({ sender }, [request, { ...request, id: "x".repeat(65) }]);

    expect(notifications.enable).toHaveBeenCalledOnce();
    expect(notifications.sync).toHaveBeenCalledWith([request]);
  } finally {
    await runtime.dispose();
  }
});

it("replaces a renderer's socket when it connects again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-ipc-"));
  const socketPath = join(dir, "daemon.sock");
  const frames = new EventEmitter();
  const server = net.createServer((socket) =>
    socket.on("data", (frame) => frames.emit("frame", { frame, socket })),
  );
  await listen(server, socketPath);
  const runtime = makeRuntime();
  const sender = new FakeSender();

  try {
    registerIpc(deps(socketPath, runtime));
    const connect = ipc.handlers.get(IpcChannel.rpcConnect);
    const send = ipc.listeners.get(IpcChannel.rpcSend);
    if (!connect || !send) throw new Error("RPC handlers were not registered");

    await connect({ sender }, 1);
    const firstReceived = once(frames, "frame");
    send({ sender }, "first");
    const [firstEvent] = await firstReceived;
    if (!firstEvent || !(firstEvent.socket instanceof net.Socket)) {
      throw new Error("First frame did not identify its socket");
    }
    const firstClosed = once(firstEvent.socket, "close");
    await connect({ sender }, 2);
    await firstClosed;
    const replacementReceived = once(frames, "frame");
    send({ sender }, "replacement");

    const [replacementEvent] = await replacementReceived;
    if (!replacementEvent || !Buffer.isBuffer(replacementEvent.frame)) {
      throw new Error("Replacement frame was not received");
    }
    expect(replacementEvent.frame.toString()).toBe("replacement");
    expect(replacementEvent.socket).not.toBe(firstEvent.socket);
    expect(firstEvent.socket.destroyed).toBe(true);
  } finally {
    await runtime.dispose();
    await closeServer(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

it("closes a renderer's socket before its reconnect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-ipc-"));
  const socketPath = join(dir, "daemon.sock");
  const accepted = Promise.withResolvers<net.Socket>();
  const server = net.createServer((socket) => accepted.resolve(socket));
  await listen(server, socketPath);
  const runtime = makeRuntime();
  const sender = new FakeSender();

  try {
    registerIpc(deps(socketPath, runtime));
    const connect = ipc.handlers.get(IpcChannel.rpcConnect);
    const disconnect = ipc.handlers.get(IpcChannel.rpcDisconnect);
    if (!connect || !disconnect) throw new Error("RPC session handlers were not registered");

    await connect({ sender }, 1);
    const socket = await accepted.promise;
    const closed = once(socket, "close");
    await disconnect({ sender });
    await closed;

    expect(socket.destroyed).toBe(true);
  } finally {
    await runtime.dispose();
    await closeServer(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

it("interrupts a pending connection when the renderer is destroyed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-ipc-"));
  const runtime = makeRuntime();
  const sender = new FakeSender();

  try {
    registerIpc(deps(join(dir, "missing.sock"), runtime));
    const connect = ipc.handlers.get(IpcChannel.rpcConnect);
    if (!connect) throw new Error("RPC connect handler was not registered");

    const pending = connect({ sender }, 1);
    await Promise.resolve();
    expect(sender.listenerCount("destroyed")).toBe(1);
    sender.emit("destroyed");

    await expect(pending).rejects.toThrow("All fibers interrupted without error");
  } finally {
    await runtime.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("drops renderer frames until its daemon connection is ready", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-ipc-"));
  const socketPath = join(dir, "daemon.sock");
  const accepted = Promise.withResolvers<net.Socket>();
  const received = Promise.withResolvers<string>();
  const server = net.createServer((socket) => {
    accepted.resolve(socket);
    socket.once("data", (chunk) => received.resolve(chunk.toString()));
  });
  const runtime = makeRuntime();
  const sender = new FakeSender();

  try {
    registerIpc(deps(socketPath, runtime));
    const connect = ipc.handlers.get(IpcChannel.rpcConnect);
    const send = ipc.listeners.get(IpcChannel.rpcSend);
    if (!connect || !send) throw new Error("RPC handlers were not registered");

    const pending = connect({ sender }, 1);
    send({ sender }, "early");
    await listen(server, socketPath);
    await pending;
    await accepted.promise;
    send({ sender }, "ready");

    expect(await received.promise).toBe("ready");
  } finally {
    await runtime.dispose();
    await closeServer(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

it("persists profiling through the shared desktop preferences", async () => {
  const ownedSupervisor = {
    ...supervisor,
    status: Effect.runSync(SubscriptionRef.make<EngineStatus>("running")),
  };
  const runtime = ManagedRuntime.make(Layer.succeed(EngineSupervisor, ownedSupervisor));
  const set = vi.fn<WindowPreferencesStore["set"]>((preferences) => ({
    closeToHide: true,
    profiling: preferences.profiling ?? false,
  }));
  const sender = new FakeSender();

  try {
    registerIpc({
      ...deps("/tmp/test.sock", runtime),
      supervisor: ownedSupervisor,
      windowPreferences: {
        get: () => ({ closeToHide: true, profiling: false }),
        set,
      },
    });
    const update = ipc.handlers.get(IpcChannel.setWindowPreferences);
    if (!update) throw new Error("Window preferences handler was not registered");

    expect(await update({ sender }, { profiling: true })).toEqual({
      closeToHide: true,
      profiling: true,
    });
    expect(set).toHaveBeenCalledWith({ profiling: true });
  } finally {
    await runtime.dispose();
  }
});

it("restores profiling preferences when the engine restart fails", async () => {
  const failedSupervisor = {
    ...supervisor,
    status: Effect.runSync(SubscriptionRef.make<EngineStatus>("running")),
    start: Effect.die("restart failed"),
  };
  const runtime = ManagedRuntime.make(Layer.succeed(EngineSupervisor, failedSupervisor));
  const cache: { current: WindowPreferences } = {
    current: { closeToHide: true, profiling: false },
  };
  const set = vi.fn<WindowPreferencesStore["set"]>((preferences) => {
    cache.current = { ...cache.current, ...preferences };
    return cache.current;
  });
  const sender = new FakeSender();

  try {
    registerIpc({
      ...deps("/tmp/test.sock", runtime),
      supervisor: failedSupervisor,
      windowPreferences: { get: () => cache.current, set },
    });
    const update = ipc.handlers.get(IpcChannel.setWindowPreferences);
    if (!update) throw new Error("Window preferences handler was not registered");

    await expect(update({ sender }, { profiling: true })).rejects.toThrow("restart failed");
    expect(cache.current).toEqual({ closeToHide: true, profiling: false });
    expect(set).toHaveBeenLastCalledWith({ closeToHide: true, profiling: false });
  } finally {
    await runtime.dispose();
  }
});

it("rejects profiling for an adopted standalone daemon", async () => {
  const runtime = makeRuntime();
  const sender = new FakeSender();

  try {
    registerIpc(deps("/tmp/test.sock", runtime));
    const update = ipc.handlers.get(IpcChannel.setWindowPreferences);
    if (!update) throw new Error("Window preferences handler was not registered");

    await expect(update({ sender }, { profiling: true })).rejects.toThrow(
      "Stop the standalone daemon before enabling profiling",
    );
  } finally {
    await runtime.dispose();
  }
});

it("leaves an adopted standalone daemon alone when profiling is disabled", async () => {
  const start = vi.fn<() => void>();
  const stop = vi.fn<() => void>();
  const adoptedSupervisor = {
    ...supervisor,
    status: Effect.runSync(SubscriptionRef.make<EngineStatus>("adopted")),
    start: Effect.sync(start),
    stop: Effect.sync(stop),
  };
  const runtime = ManagedRuntime.make(Layer.succeed(EngineSupervisor, adoptedSupervisor));
  const sender = new FakeSender();

  try {
    registerIpc({
      ...deps("/tmp/test.sock", runtime),
      supervisor: adoptedSupervisor,
      windowPreferences: {
        get: () => ({ closeToHide: true, profiling: true }),
        set: (preferences: { readonly profiling?: boolean }) => ({
          closeToHide: true,
          profiling: preferences.profiling ?? true,
        }),
      },
    });
    const update = ipc.handlers.get(IpcChannel.setWindowPreferences);
    if (!update) throw new Error("Window preferences handler was not registered");

    expect(await update({ sender }, { profiling: false })).toEqual({
      closeToHide: true,
      profiling: false,
    });
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  } finally {
    await runtime.dispose();
  }
});

it("captures profiles from the main process and owned daemon", async () => {
  const runtime = makeRuntime();
  const sender = new FakeSender();
  const profilingPreferences = {
    ...windowPreferences,
    get: () => ({ closeToHide: true, profiling: true }),
  };

  try {
    registerIpc({
      ...deps("/tmp/test.sock", runtime),
      windowPreferences: profilingPreferences,
    });
    const captureMain = ipc.handlers.get(IpcChannel.captureProcessProfile);
    if (!captureMain) throw new Error("Process profile handler was not registered");

    await expect(captureMain({ sender }, { _tag: "MainHeapSnapshot" })).resolves.toBe(
      "/diagnostics/main.heapsnapshot",
    );

    registerIpc({
      ...deps("/tmp/test.sock", runtime),
      windowPreferences: profilingPreferences,
    });
    const captureEngine = ipc.handlers.get(IpcChannel.captureProcessProfile);
    if (!captureEngine) throw new Error("Process profile handler was not registered");
    await expect(captureEngine({ sender }, { _tag: "DaemonHeapSnapshot" })).resolves.toBe(
      "/diagnostics/engine.heapsnapshot",
    );
  } finally {
    await runtime.dispose();
  }
});

it("rejects rapid repeated profile captures", async () => {
  const runtime = makeRuntime();
  const sender = new FakeSender();

  try {
    registerIpc({
      ...deps("/tmp/test.sock", runtime),
      windowPreferences: {
        ...windowPreferences,
        get: () => ({ closeToHide: true, profiling: true }),
      },
    });
    const capture = ipc.handlers.get(IpcChannel.captureProcessProfile);
    if (!capture) throw new Error("Process profile handler was not registered");

    await capture({ sender }, { _tag: "MainHeapSnapshot" });
    await expect(capture({ sender }, { _tag: "MainHeapSnapshot" })).rejects.toThrow(
      "Wait before starting another process profile",
    );
  } finally {
    await runtime.dispose();
  }
});

it("allows an immediate retry after a rejected profile capture", async () => {
  const runtime = makeRuntime();
  const sender = new FakeSender();
  const getPreferences = vi
    .fn<WindowPreferencesStore["get"]>()
    .mockReturnValueOnce({ closeToHide: true, profiling: false })
    .mockReturnValue({ closeToHide: true, profiling: true });

  try {
    registerIpc({
      ...deps("/tmp/test.sock", runtime),
      windowPreferences: { ...windowPreferences, get: getPreferences },
    });
    const capture = ipc.handlers.get(IpcChannel.captureProcessProfile);
    if (!capture) throw new Error("Process profile handler was not registered");

    await expect(capture({ sender }, { _tag: "MainHeapSnapshot" })).rejects.toThrow("Profiling is disabled");
    await expect(capture({ sender }, { _tag: "MainHeapSnapshot" })).resolves.toBe(
      "/diagnostics/main.heapsnapshot",
    );
  } finally {
    await runtime.dispose();
  }
});

it("rejects diagnostics from an untrusted renderer", async () => {
  const runtime = makeRuntime();
  const sender = new FakeSender();

  try {
    registerIpc({
      ...deps("/tmp/test.sock", runtime),
      isTrustedSender: () => false,
      windowPreferences: {
        ...windowPreferences,
        get: () => ({ closeToHide: true, profiling: true }),
      },
    });
    const capture = ipc.handlers.get(IpcChannel.captureProcessProfile);
    if (!capture) throw new Error("Process profile handler was not registered");

    await expect(capture({ sender }, { _tag: "MainHeapSnapshot" })).rejects.toThrow(
      "Diagnostics are unavailable from this renderer",
    );
  } finally {
    await runtime.dispose();
  }
});
