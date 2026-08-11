import { EventEmitter } from "node:events";
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

const command: EngineCommand = { command: "tsx", args: ["daemon"], cwd: "/repo" };

const silentLogger = { info: () => {}, warn: () => {} };

const makeSupervisor = (
  overrides: Partial<EngineSupervisorOptions> & Pick<EngineSupervisorOptions, "probe" | "spawn">,
) => {
  const statuses: EngineStatus[] = [];
  const supervisor = new EngineSupervisor({
    command,
    socketPath: "/tmp/test.sock",
    onStatus: (status) => statuses.push(status),
    logger: silentLogger,
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

    expect(spawn).toHaveBeenCalledOnce();
    expect(supervisor.status).toBe("running");
    expect(statuses).toEqual(["starting", "running"]);
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
