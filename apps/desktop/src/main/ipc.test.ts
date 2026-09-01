import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer, ManagedRuntime } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { IpcChannel } from "../shared/ipc";
import { EngineSupervisor } from "./engine-supervisor";

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
  mainLogger: { warn: vi.fn() },
  rendererLogger: { error: vi.fn() },
}));

import { registerIpc } from "./ipc";

class FakeSender extends EventEmitter {
  readonly id = 1;
  readonly send = vi.fn();

  isDestroyed() {
    return false;
  }
}

const supervisor = new EngineSupervisor({
  command: { command: "node", args: [], cwd: "/tmp" },
  socketPath: "/tmp/unused.sock",
  spawn: () => {
    throw new Error("not used");
  },
  probe: () => Promise.resolve(true),
  awaitReachable: () => Promise.resolve(true),
  onStatus: () => {},
  logger: { info: () => {}, warn: () => {} },
});

const windowPreferences = {
  get: () => ({ closeToHide: true }),
  set: (preferences: { readonly closeToHide: boolean }) => preferences,
};

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
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const runtime = ManagedRuntime.make(Layer.empty);
  const sender = new FakeSender();

  try {
    registerIpc({ socketPath, supervisor, windowPreferences, runtime });
    const connect = ipc.handlers.get(IpcChannel.rpcConnect);
    if (!connect) throw new Error("RPC connect handler was not registered");

    await connect({ sender });
    await accepted.promise;
    sender.emit("destroyed");
    await closed.promise;

    expect((await accepted.promise).destroyed).toBe(true);
  } finally {
    await runtime.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const runtime = ManagedRuntime.make(Layer.empty);
  const sender = new FakeSender();

  try {
    registerIpc({ socketPath, supervisor, windowPreferences, runtime });
    const connect = ipc.handlers.get(IpcChannel.rpcConnect);
    if (!connect) throw new Error("RPC connect handler was not registered");

    const resolved = await connect({ sender });

    expect(() => structuredClone(resolved)).not.toThrow();
  } finally {
    await runtime.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

it("replaces a renderer's socket when it connects again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-ipc-"));
  const socketPath = join(dir, "daemon.sock");
  const frames = new EventEmitter();
  const server = net.createServer((socket) =>
    socket.on("data", (frame) => frames.emit("frame", { frame, socket })),
  );
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const runtime = ManagedRuntime.make(Layer.empty);
  const sender = new FakeSender();

  try {
    registerIpc({ socketPath, supervisor, windowPreferences, runtime });
    const connect = ipc.handlers.get(IpcChannel.rpcConnect);
    const send = ipc.listeners.get(IpcChannel.rpcSend);
    if (!connect || !send) throw new Error("RPC handlers were not registered");

    await connect({ sender });
    const firstReceived = once(frames, "frame");
    send({ sender }, "first");
    const [firstEvent] = await firstReceived;
    if (!firstEvent || !(firstEvent.socket instanceof net.Socket)) {
      throw new Error("First frame did not identify its socket");
    }
    const firstClosed = once(firstEvent.socket, "close");
    await connect({ sender });
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

it("interrupts a pending connection when the renderer is destroyed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cf-ipc-"));
  const runtime = ManagedRuntime.make(Layer.empty);
  const sender = new FakeSender();

  try {
    registerIpc({ socketPath: join(dir, "missing.sock"), supervisor, windowPreferences, runtime });
    const connect = ipc.handlers.get(IpcChannel.rpcConnect);
    if (!connect) throw new Error("RPC connect handler was not registered");

    const pending = connect({ sender });
    await Promise.resolve();
    expect(sender.listenerCount("destroyed")).toBe(1);
    sender.emit("destroyed");

    await expect(pending).rejects.toThrow();
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
  const runtime = ManagedRuntime.make(Layer.empty);
  const sender = new FakeSender();

  try {
    registerIpc({ socketPath, supervisor, windowPreferences, runtime });
    const connect = ipc.handlers.get(IpcChannel.rpcConnect);
    const send = ipc.listeners.get(IpcChannel.rpcSend);
    if (!connect || !send) throw new Error("RPC handlers were not registered");

    const pending = connect({ sender });
    send({ sender }, "early");
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    await pending;
    await accepted.promise;
    send({ sender }, "ready");

    expect(await received.promise).toBe("ready");
  } finally {
    await runtime.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
