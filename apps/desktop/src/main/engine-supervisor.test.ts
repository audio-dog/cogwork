import { EventEmitter } from "node:events";
import type { SchedulingState } from "@cogwork/contracts";
import { describe, expect, it, vi } from "vitest";
import type { EngineStatus } from "../shared/ipc";
import type { EngineCommand } from "./engine-command";
import { type EngineChild, EngineSupervisor, type EngineSupervisorOptions } from "./engine-supervisor";

class FakeChild extends EventEmitter implements EngineChild {
  readonly pid = 1234;
  readonly stdout = null;
  readonly stderr = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", 0, "SIGTERM"));
    return true;
  }
}

const launchCommand: EngineCommand = { command: "tsx", args: ["daemon", "paused"], cwd: "/repo" };
const liveRestartCommand: EngineCommand = { command: "tsx", args: ["daemon", "live"], cwd: "/repo" };

const resolveCommand = (restart: boolean, scheduling: SchedulingState): EngineCommand =>
  restart && scheduling === "running" ? liveRestartCommand : launchCommand;

const silentLogger = { info: () => {}, warn: () => {} };

const flush = (): Promise<void> => new Promise<void>((resolve) => queueMicrotask(resolve));

const deferred = <T>() => {
  const box: { resolve: (value: T) => void } = { resolve: () => {} };
  const promise = new Promise<T>((resolve) => {
    box.resolve = resolve;
  });
  return { promise, resolve: (value: T) => box.resolve(value) };
};

const makeSupervisor = (
  overrides: Partial<EngineSupervisorOptions> & Pick<EngineSupervisorOptions, "probe" | "spawn">,
) => {
  const statuses: EngineStatus[] = [];
  const supervisor = new EngineSupervisor({
    resolveCommand,
    socketPath: "/tmp/test.sock",
    onStatus: (status) => statuses.push(status),
    logger: silentLogger,
    awaitReachable: () => Promise.resolve(true),
    ...overrides,
  });
  return { supervisor, statuses };
};

describe("EngineSupervisor", () => {
  it("adopts an existing daemon without spawning", async () => {
    const spawn = vi.fn(() => new FakeChild());
    const { supervisor, statuses } = makeSupervisor({ probe: () => Promise.resolve(true), spawn });

    await supervisor.start();

    expect(spawn).not.toHaveBeenCalled();
    expect(supervisor.status).toBe("adopted");
    expect(statuses).toEqual(["adopted"]);
  });

  it("spawns the engine when nothing is listening", async () => {
    const spawn = vi.fn(() => new FakeChild());
    const { supervisor, statuses } = makeSupervisor({ probe: () => Promise.resolve(false), spawn });

    await supervisor.start();
    await flush();

    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(launchCommand);
    expect(supervisor.status).toBe("running");
    expect(statuses).toEqual(["starting", "running"]);
  });

  it("stays in starting until the socket is reachable, then reports running", async () => {
    const gate = deferred<boolean>();
    const { supervisor, statuses } = makeSupervisor({
      probe: () => Promise.resolve(false),
      spawn: () => new FakeChild(),
      awaitReachable: () => gate.promise,
    });

    await supervisor.start();
    await flush();
    expect(supervisor.status).toBe("starting");
    expect(statuses).toEqual(["starting"]);

    gate.resolve(true);
    await flush();
    expect(supervisor.status).toBe("running");
    expect(statuses).toEqual(["starting", "running"]);
  });

  it("never reports running when the child exits before the socket is reachable", async () => {
    const gate = deferred<boolean>();
    const child = new FakeChild();
    const { supervisor, statuses } = makeSupervisor({
      probe: () => Promise.resolve(false),
      spawn: () => child,
      maxRestarts: 0,
      awaitReachable: (_socketPath, signal) => {
        signal.addEventListener("abort", () => gate.resolve(false), { once: true });
        return gate.promise;
      },
    });

    await supervisor.start();
    await flush();
    expect(supervisor.status).toBe("starting");

    child.emit("exit", 1, null);
    await flush();

    expect(supervisor.status).toBe("failed");
    expect(statuses).not.toContain("running");
  });

  it("restarts on unexpected exit up to the limit, then fails", async () => {
    const children: FakeChild[] = [];
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const { supervisor } = makeSupervisor({
      probe: () => Promise.resolve(false),
      spawn,
      maxRestarts: 2,
    });

    await supervisor.start();
    children[0].emit("exit", 1, null);
    children[1].emit("exit", 1, null);
    children[2].emit("exit", 1, null);

    expect(spawn).toHaveBeenCalledTimes(3);
    expect(supervisor.status).toBe("failed");
  });

  it("restarts with scheduling live when the renderer last reported running", async () => {
    const children: FakeChild[] = [];
    const spawn = vi.fn((engine: EngineCommand) => {
      const child = new FakeChild();
      children.push(child);
      expect(engine).toEqual(children.length === 1 ? launchCommand : liveRestartCommand);
      return child;
    });
    const { supervisor } = makeSupervisor({
      probe: () => Promise.resolve(false),
      spawn,
      maxRestarts: 1,
    });

    await supervisor.start();
    supervisor.setScheduling("running");
    children[0].emit("exit", 1, null);
    await flush();

    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("keeps scheduling paused on restart when the renderer never resumed it", async () => {
    const children: FakeChild[] = [];
    const spawn = vi.fn((engine: EngineCommand) => {
      const child = new FakeChild();
      children.push(child);
      expect(engine).toEqual(launchCommand);
      return child;
    });
    const { supervisor } = makeSupervisor({
      probe: () => Promise.resolve(false),
      spawn,
      maxRestarts: 1,
    });

    await supervisor.start();
    children[0].emit("exit", 1, null);
    await flush();

    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("stops an owned engine by terminating the child", async () => {
    const child = new FakeChild();
    const { supervisor, statuses } = makeSupervisor({
      probe: () => Promise.resolve(false),
      spawn: () => child,
    });

    await supervisor.start();
    await supervisor.stop();

    expect(child.killed).toBe(true);
    expect(supervisor.status).toBe("stopped");
    expect(statuses.at(-1)).toBe("stopped");
  });

  it("leaves an adopted engine running on stop", async () => {
    const spawn = vi.fn(() => new FakeChild());
    const { supervisor } = makeSupervisor({ probe: () => Promise.resolve(true), spawn });

    await supervisor.start();
    await supervisor.stop();

    expect(spawn).not.toHaveBeenCalled();
    expect(supervisor.status).toBe("stopped");
  });
});
