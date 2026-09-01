import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Effect, Layer, Logger, ManagedRuntime, Stream, SubscriptionRef } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { EngineStatus } from "../shared/ipc";
import type { EngineCommand } from "./engine-command";
import {
  type EngineChild,
  EngineSupervisor,
  type EngineSupervisorOptions,
  type EngineSupervisorService,
} from "./engine-supervisor";

class FakeChild extends EventEmitter implements EngineChild {
  readonly pid = 1234;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];

  constructor(private readonly exitOnSignal: NodeJS.Signals | null = "SIGTERM") {
    super();
  }

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.signals.push(signal);
    if (signal === this.exitOnSignal) queueMicrotask(() => this.emit("exit", 0, signal));
    return true;
  }
}

class ShutdownOutputChild extends FakeChild {
  override kill(signal: NodeJS.Signals = "SIGTERM") {
    this.stdout.end();
    this.stderr.end("shutdown diagnostic\n");
    return super.kill(signal);
  }
}

const command: EngineCommand = {
  command: "tsx",
  args: ["daemon"],
  cwd: "/repo",
  terminateTimeoutMillis: 10_000,
};

const options = (
  overrides: Partial<EngineSupervisorOptions> & Pick<EngineSupervisorOptions, "spawn">,
): EngineSupervisorOptions => ({
  command,
  socketPath: "/tmp/test.sock",
  probe: () => Effect.succeed(false),
  awaitReachable: () => Effect.void,
  terminateTimeout: 0,
  forceKillTimeout: 0,
  ...overrides,
});

const withSupervisor = async (
  supervisorOptions: EngineSupervisorOptions,
  run: (
    runtime: ManagedRuntime.ManagedRuntime<EngineSupervisor, never>,
    supervisor: EngineSupervisorService,
  ) => Promise<void>,
  loggerLayer: Layer.Layer<never> = Layer.empty,
) => {
  const runtime = ManagedRuntime.make(Layer.merge(EngineSupervisor.layer(supervisorOptions), loggerLayer));
  const supervisor = runtime.runSync(EngineSupervisor);
  try {
    await run(runtime, supervisor);
  } finally {
    await runtime.dispose();
  }
};

const currentStatus = (
  runtime: ManagedRuntime.ManagedRuntime<EngineSupervisor, never>,
  supervisor: EngineSupervisorService,
) => runtime.runPromise(SubscriptionRef.get(supervisor.status));

const collectStatuses = (
  runtime: ManagedRuntime.ManagedRuntime<EngineSupervisor, never>,
  supervisor: EngineSupervisorService,
  count: number,
) =>
  runtime.runPromise(
    SubscriptionRef.changes(supervisor.status).pipe(
      Stream.take(count),
      Stream.runCollect,
      Effect.map(Array.from),
    ),
  );

const yieldToSupervisor = (runtime: ManagedRuntime.ManagedRuntime<EngineSupervisor, never>) =>
  runtime.runPromise(Effect.yieldNow);

const yieldUntil = (
  runtime: ManagedRuntime.ManagedRuntime<EngineSupervisor, never>,
  predicate: () => boolean,
) => runtime.runPromise(Effect.yieldNow.pipe(Effect.repeat({ until: predicate })));

const awaitStatus = (
  runtime: ManagedRuntime.ManagedRuntime<EngineSupervisor, never>,
  supervisor: EngineSupervisorService,
  expected: EngineStatus,
) =>
  runtime.runPromise(
    SubscriptionRef.changes(supervisor.status).pipe(
      Stream.filter((status) => status === expected),
      Stream.take(1),
      Stream.runDrain,
    ),
  );

const crashChild = (child: FakeChild) => {
  child.emit("exit", 1, null);
  child.stdout.end();
  child.stderr.end();
};

describe("EngineSupervisor", () => {
  it("adopts an existing daemon without spawning", async () => {
    const spawn = vi.fn(() => new FakeChild());

    await withSupervisor(
      options({ probe: () => Effect.succeed(true), spawn }),
      async (runtime, supervisor) => {
        await runtime.runPromise(supervisor.start);

        expect(spawn).not.toHaveBeenCalled();
        expect(await currentStatus(runtime, supervisor)).toBe("adopted");
      },
    );
  });

  it("publishes starting and running status changes", async () => {
    await withSupervisor(options({ spawn: () => new FakeChild() }), async (runtime, supervisor) => {
      const statuses = collectStatuses(runtime, supervisor, 3);

      await runtime.runPromise(supervisor.start);

      expect(await statuses).toEqual(["stopped", "starting", "running"]);
    });
  });

  it("stays starting until the socket is reachable", async () => {
    const reachable = Promise.withResolvers<void>();

    await withSupervisor(
      options({
        spawn: () => new FakeChild(),
        awaitReachable: () => Effect.promise(() => reachable.promise),
      }),
      async (runtime, supervisor) => {
        await runtime.runPromise(supervisor.start);
        expect(await currentStatus(runtime, supervisor)).toBe("starting");

        reachable.resolve();
        await yieldToSupervisor(runtime);

        expect(await currentStatus(runtime, supervisor)).toBe("running");
      },
    );
  });

  it("never reports running after the child exits", async () => {
    const child = new FakeChild();
    const reachable = Promise.withResolvers<void>();

    await withSupervisor(
      options({
        spawn: () => child,
        maxRestarts: 0,
        awaitReachable: () => Effect.promise(() => reachable.promise),
      }),
      async (runtime, supervisor) => {
        const statuses = collectStatuses(runtime, supervisor, 3);
        await runtime.runPromise(supervisor.start);
        crashChild(child);

        expect(await statuses).toEqual(["stopped", "starting", "failed"]);
      },
    );
  });

  it("restarts unexpected exits up to the schedule budget", async () => {
    const children: FakeChild[] = [];
    const spawn = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });

    await withSupervisor(options({ spawn, maxRestarts: 2 }), async (runtime, supervisor) => {
      const failed = awaitStatus(runtime, supervisor, "failed");
      await runtime.runPromise(supervisor.start);
      if (children[0]) crashChild(children[0]);
      await yieldUntil(runtime, () => children.length === 2);
      if (children[1]) crashChild(children[1]);
      await yieldUntil(runtime, () => children.length === 3);
      if (children[2]) crashChild(children[2]);
      await failed;

      expect(spawn).toHaveBeenCalledTimes(3);
      expect(await currentStatus(runtime, supervisor)).toBe("failed");
    });
  });

  it("escalates to SIGKILL and finishes when the child never exits", async () => {
    const child = new FakeChild(null);

    await withSupervisor(options({ spawn: () => child }), async (runtime, supervisor) => {
      await runtime.runPromise(supervisor.start);
      await yieldToSupervisor(runtime);
      await runtime.runPromise(supervisor.stop);

      expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(await currentStatus(runtime, supervisor)).toBe("stopped");
    });
  });

  it("leaves an adopted engine running on stop", async () => {
    const spawn = vi.fn(() => new FakeChild());

    await withSupervisor(
      options({ probe: () => Effect.succeed(true), spawn }),
      async (runtime, supervisor) => {
        await runtime.runPromise(supervisor.start);
        await runtime.runPromise(supervisor.stop);

        expect(spawn).not.toHaveBeenCalled();
        expect(await currentStatus(runtime, supervisor)).toBe("stopped");
      },
    );
  });

  it("logs output flushed while stopping the child", async () => {
    const child = new ShutdownOutputChild();
    const entries: unknown[] = [];
    const capture = Logger.make(({ message }) => entries.push(message));

    await withSupervisor(
      options({ spawn: () => child }),
      async (runtime, supervisor) => {
        await runtime.runPromise(supervisor.start);
        await runtime.runPromise(supervisor.stop);

        expect(entries).toContainEqual(["Engine output", { line: "shutdown diagnostic", stream: "stderr" }]);
      },
      Logger.layer([capture], { mergeWithExisting: false }),
    );
  });

  it("logs complete stdout lines with structured fields", async () => {
    const child = new FakeChild();
    const entries: unknown[] = [];
    const capture = Logger.make(({ message }) => entries.push(message));

    await withSupervisor(
      options({ spawn: () => child }),
      async (runtime, supervisor) => {
        await runtime.runPromise(supervisor.start);
        await yieldToSupervisor(runtime);
        child.stdout.write("split");
        await yieldToSupervisor(runtime);
        child.stdout.write(" line\nnext line\n");
        await yieldToSupervisor(runtime);

        expect(entries).toContainEqual(["Engine output", { line: "split line", stream: "stdout" }]);
        expect(entries).toContainEqual(["Engine output", { line: "next line", stream: "stdout" }]);
      },
      Logger.layer([capture], { mergeWithExisting: false }),
    );
  });

  it("bounds stdout lines before logging", async () => {
    const child = new FakeChild();
    const entries: unknown[] = [];
    const capture = Logger.make(({ message }) => entries.push(message));
    const output = "x".repeat(32_768);

    await withSupervisor(
      options({ spawn: () => child }),
      async (runtime, supervisor) => {
        await runtime.runPromise(supervisor.start);
        await yieldToSupervisor(runtime);
        child.stdout.write(`${output}\n`);
        await yieldToSupervisor(runtime);

        const lines = entries.flatMap((entry) => {
          if (!Array.isArray(entry) || entry[0] !== "Engine output") return [];
          const fields: unknown = entry[1];
          if (!fields || typeof fields !== "object" || !("line" in fields)) return [];
          if (typeof fields.line !== "string") return [];
          return [fields.line];
        });
        expect(lines).toHaveLength(2);
        expect(lines.every((line) => line.length <= 16_384)).toBe(true);
        expect(lines.join("")).toBe(output);
      },
      Logger.layer([capture], { mergeWithExisting: false }),
    );
  });

  it("logs output flushed after the child exits", async () => {
    const child = new FakeChild();
    const entries: unknown[] = [];
    const capture = Logger.make(({ message }) => entries.push(message));

    await withSupervisor(
      options({ maxRestarts: 0, spawn: () => child }),
      async (runtime, supervisor) => {
        const statuses = collectStatuses(runtime, supervisor, 4);
        await runtime.runPromise(supervisor.start);
        await yieldToSupervisor(runtime);
        child.emit("exit", 1, null);
        queueMicrotask(() => {
          child.stdout.end();
          child.stderr.end("last diagnostic\n");
        });

        await statuses;
        expect(entries).toContainEqual(["Engine output", { line: "last diagnostic", stream: "stderr" }]);
      },
      Logger.layer([capture], { mergeWithExisting: false }),
    );
  });
});
