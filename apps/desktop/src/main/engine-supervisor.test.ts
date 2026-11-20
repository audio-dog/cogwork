import { PassThrough } from "node:stream";

import { ProcessProfileRequest } from "@cogwork/process-diagnostics";
import { NodeStream } from "@effect/platform-node";
import { assert, describe, expect, it, vi } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
  PlatformError,
  Sink,
  Stream,
  SubscriptionRef,
} from "effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

import type { EngineStatus } from "../shared/ipc";
import type { EngineCommand } from "./engine-command";
import {
  EngineSupervisor,
  type EngineSupervisorOptions,
  type EngineSupervisorService,
  layer as engineSupervisorLayer,
} from "./engine-supervisor";
import { DaemonReachabilityError } from "./wait-for-socket";

class FakeChild {
  readonly pid = 1234;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  readonly killOptions: ChildProcess.KillOptions[] = [];
  readonly messages: unknown[] = [];
  unrefCount = 0;
  onSend: (message: unknown) => Effect.Effect<void, PlatformError.PlatformError> = () => Effect.void;
  private readonly exited = Deferred.makeUnsafe<ChildProcessSpawner.ExitCode>();
  private readonly profileResponses = new PassThrough();
  private referenced = true;
  readonly handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(this.pid),
    stdin: Sink.drain,
    stdout: NodeStream.fromReadable({ evaluate: () => this.stdout }),
    stderr: NodeStream.fromReadable({ evaluate: () => this.stderr }),
    all: Stream.empty,
    exitCode: Deferred.await(this.exited),
    isRunning: Deferred.isDone(this.exited).pipe(Effect.map((done) => !done)),
    kill: (options) =>
      Effect.sync(() => {
        const signal = options?.killSignal ?? "SIGTERM";
        this.killOptions.push(options ?? {});
        this.beforeKill();
        this.signals.push(signal);
        if (signal === this.exitOnSignal) {
          this.close(0);
          return;
        }
        if (options?.forceKillAfter !== undefined) this.signals.push("SIGKILL");
      }).pipe(Effect.andThen(this.awaitExitAfterKill())),
    getInputFd: (fd) =>
      fd === 3
        ? Sink.forEachArray((chunks: ReadonlyArray<Uint8Array>) =>
            Effect.forEach(chunks, (bytes) => this.send(new TextDecoder().decode(bytes)), {
              discard: true,
            }),
          )
        : Sink.drain,
    getOutputFd: (fd) =>
      fd === 4 ? NodeStream.fromReadable({ evaluate: () => this.profileResponses }) : Stream.empty,
    unref: Effect.sync(() => {
      this.unrefCount += 1;
      this.referenced = false;
      return Effect.sync(() => {
        this.referenced = true;
      });
    }),
  });

  constructor(
    private readonly exitOnSignal: NodeJS.Signals | null = "SIGTERM",
    private readonly killFailure?: PlatformError.PlatformError,
  ) {}

  protected beforeKill() {}

  private awaitExitAfterKill() {
    if (this.killFailure) return Effect.fail(this.killFailure);
    if (this.exitOnSignal === null) return Effect.never;
    return Deferred.await(this.exited).pipe(Effect.asVoid);
  }

  close(code: number) {
    this.profileResponses.end();
    Deferred.doneUnsafe(this.exited, Effect.succeed(ChildProcessSpawner.ExitCode(code)));
  }

  respond(message: unknown) {
    this.profileResponses.write(`${JSON.stringify(message)}\n`);
  }

  closeProfileResponses() {
    this.profileResponses.end();
  }

  finalize() {
    return Deferred.isDone(this.exited).pipe(
      Effect.flatMap((exited) => (exited || !this.referenced ? Effect.void : Effect.never)),
    );
  }

  private send(text: string) {
    const message = Schema.decodeUnknownSync(ProcessProfileRequest)(JSON.parse(text));
    this.messages.push(message);
    return this.onSend(message);
  }
}

class ShutdownOutputChild extends FakeChild {
  protected override beforeKill() {
    this.stdout.end();
    this.stderr.end("shutdown diagnostic\n");
  }
}

const command: EngineCommand = { command: "tsx", args: ["daemon"], cwd: "/repo" };

interface TestSupervisorOptions extends EngineSupervisorOptions {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}

const options = (
  overrides: Partial<EngineSupervisorOptions> & {
    readonly spawn: (command: ChildProcess.Command) => FakeChild;
  },
): TestSupervisorOptions => {
  const { spawn, ...supervisor } = overrides;
  return {
    command: () => command,
    environment: { PATH: "/usr/bin" },
    socketPath: "/tmp/test.sock",
    probe: () => Effect.succeed(false),
    awaitReachable: () => Effect.void,
    terminateTimeout: 0,
    forceKillTimeout: 0,
    ...supervisor,
    spawner: ChildProcessSpawner.make((childCommand) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          expect(ChildProcess.isStandardCommand(childCommand)).toBe(true);
          const child = spawn(childCommand);
          return { child, handle: child.handle };
        }),
        ({ child }) => child.finalize(),
      ).pipe(Effect.map(({ handle }) => handle)),
    ),
  };
};

const supervisorTestLayer = (supervisorOptions: TestSupervisorOptions) => {
  const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, supervisorOptions.spawner);
  return engineSupervisorLayer(supervisorOptions).pipe(Layer.provide(spawnerLayer));
};

const withSupervisor = async (
  supervisorOptions: TestSupervisorOptions,
  run: (
    runtime: ManagedRuntime.ManagedRuntime<EngineSupervisor, never>,
    supervisor: EngineSupervisorService,
  ) => Promise<void>,
  loggerLayer: Layer.Layer<never> = Layer.empty,
) => {
  const runtime = ManagedRuntime.make(Layer.merge(supervisorTestLayer(supervisorOptions), loggerLayer));
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
  child.stdout.end();
  child.stderr.end();
  child.close(1);
};

describe("EngineSupervisor", () => {
  it("uses the full desktop main module path in its service tag", () => {
    expect(EngineSupervisor.key).toBe("@cogwork/desktop/main/engine-supervisor");
  });

  it("settles startup interruption when the runtime drains", async () => {
    const probing = Promise.withResolvers<void>();

    await withSupervisor(
      options({
        spawn: () => new FakeChild(),
        probe: () =>
          Effect.promise(() => {
            probing.resolve();
            return Promise.withResolvers<boolean>().promise;
          }),
      }),
      async (runtime, supervisor) => {
        const starting = runtime.runPromiseExit(supervisor.start);
        await probing.promise;
        await runtime.dispose();
        const exit = await starting;

        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      },
    );
  });

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

  it("spawns the resolved command through ChildProcessSpawner", async () => {
    const child = new FakeChild();
    const environment = { PATH: "/home/test/.local/bin:/usr/bin", KEEP: "yes" };
    const spawn = vi.fn((_spawned: ChildProcess.Command) => child);

    await withSupervisor(options({ environment, spawn }), async (runtime, supervisor) => {
      await runtime.runPromise(supervisor.start);

      expect(spawn).toHaveBeenCalledOnce();
      const spawned = spawn.mock.calls[0]?.[0];
      expect(spawned && ChildProcess.isStandardCommand(spawned)).toBe(true);
      if (!spawned || !ChildProcess.isStandardCommand(spawned)) return;
      expect(spawned.command).toBe(command.command);
      expect(spawned.args).toEqual(command.args);
      expect(spawned.options).toMatchObject({
        cwd: command.cwd,
        env: { ...environment, COGWORK_PROFILE_FD_TRANSPORT: "1" },
        extendEnv: false,
        forceKillAfter: 0,
        stdin: "ignore",
      });
    });
  });

  it("captures a live daemon profile through file descriptors", async () => {
    const child = new FakeChild();
    child.onSend = (message) =>
      Effect.sync(() => {
        const request = Schema.decodeUnknownSync(ProcessProfileRequest)(message);
        queueMicrotask(() =>
          child.respond({
            _tag: "ProcessProfileCompleted",
            requestId: request.requestId,
            path: "/diagnostics/CPU.1234.cpuprofile",
          }),
        );
      });

    await withSupervisor(options({ spawn: () => child }), async (runtime, supervisor) => {
      await runtime.runPromise(supervisor.start);
      const path = await runtime.runPromise(
        supervisor.captureProfile({
          _tag: "CpuProfile",
          directory: "/diagnostics",
          durationMillis: 0,
        }),
      );

      expect(path).toBe("/diagnostics/CPU.1234.cpuprofile");
      expect(child.messages).toHaveLength(1);
    });
  });

  it("reports close details when the daemon exits during profile capture", async () => {
    const child = new FakeChild();

    await withSupervisor(options({ maxRestarts: 0, spawn: () => child }), async (runtime, supervisor) => {
      await runtime.runPromise(supervisor.start);
      const capture = runtime.runPromise(
        supervisor.captureProfile({
          _tag: "HeapSnapshot",
          directory: "/diagnostics",
        }),
      );
      const failed = expect(capture).rejects.toMatchObject({
        operation: "capture daemon profile",
        cause: "Engine closed during profile capture (code 137)",
      });
      await yieldUntil(runtime, () => child.messages.length === 1);
      child.stdout.end();
      child.stderr.end();
      child.close(137);

      await failed;
    });
  });

  it("fails profile capture when the response descriptor closes", async () => {
    const child = new FakeChild();

    await withSupervisor(options({ spawn: () => child }), async (runtime, supervisor) => {
      await runtime.runPromise(supervisor.start);
      child.closeProfileResponses();
      await yieldToSupervisor(runtime);

      await expect(
        runtime.runPromise(
          supervisor.captureProfile({
            _tag: "HeapSnapshot",
            directory: "/diagnostics",
          }),
        ),
      ).rejects.toMatchObject({
        operation: "capture daemon profile",
        cause: "Profile response stream closed",
      });
    });
  });

  it("rejects oversized profile responses", async () => {
    const child = new FakeChild();
    child.onSend = (message) =>
      Effect.sync(() => {
        const request = Schema.decodeUnknownSync(ProcessProfileRequest)(message);
        queueMicrotask(() =>
          child.respond({
            _tag: "ProcessProfileFailed",
            requestId: request.requestId,
            message: "x".repeat(16_385),
          }),
        );
      });

    await withSupervisor(options({ spawn: () => child }), async (runtime, supervisor) => {
      await runtime.runPromise(supervisor.start);

      await expect(
        runtime.runPromise(
          supervisor.captureProfile({
            _tag: "HeapSnapshot",
            directory: "/diagnostics",
          }),
        ),
      ).rejects.toMatchObject({
        operation: "capture daemon profile",
        cause: "Profile response stream closed",
      });
    });
  });

  it("gives each serialized profile capture its full timeout", async () => {
    const child = new FakeChild();
    child.onSend = (message) =>
      Effect.sleep("600 millis").pipe(
        Effect.andThen(
          Effect.sync(() => {
            const request = Schema.decodeUnknownSync(ProcessProfileRequest)(message);
            child.respond({
              _tag: "ProcessProfileCompleted",
              requestId: request.requestId,
              path: `/diagnostics/${request.requestId}.cpuprofile`,
            });
          }),
        ),
      );

    await withSupervisor(
      options({ profileCaptureTimeout: "1 second", spawn: () => child }),
      async (runtime, supervisor) => {
        await runtime.runPromise(supervisor.start);
        const input = {
          _tag: "CpuProfile" as const,
          directory: "/diagnostics",
          durationMillis: 0,
        };

        const paths = await Promise.all([
          runtime.runPromise(supervisor.captureProfile(input)),
          runtime.runPromise(supervisor.captureProfile(input)),
        ]);

        expect(paths).toEqual(["/diagnostics/1234:0.cpuprofile", "/diagnostics/1234:1.cpuprofile"]);
      },
    );
  });

  it("fails profile capture when the request write fails", async () => {
    const child = new FakeChild();
    child.onSend = () =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "Unknown",
          module: "ChildProcess",
          method: "send",
          description: "send failed",
        }),
      );

    await withSupervisor(options({ spawn: () => child }), async (runtime, supervisor) => {
      await runtime.runPromise(supervisor.start);
      const exit = await runtime.runPromiseExit(
        supervisor.captureProfile({
          _tag: "HeapSnapshot",
          directory: "/diagnostics",
        }),
      );

      const failure = Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        : undefined;
      expect(failure?.cause).toBe("Profile request stream closed");
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

  it.live("reports failed when the daemon does not become reachable", () => {
    const child = new FakeChild("SIGUSR1");
    const deadline = Deferred.makeUnsafe<void>();
    const supervisorOptions = options({
      spawn: () => child,
      awaitReachable: () =>
        Deferred.await(deadline).pipe(
          Effect.andThen(Effect.fail(new DaemonReachabilityError({ deadline: "10 seconds" }))),
        ),
      terminateTimeout: "1 hour",
    });

    return Effect.gen(function* () {
      const supervisor = yield* EngineSupervisor;
      yield* supervisor.start;
      yield* Deferred.succeed(deadline, undefined);
      yield* Effect.yieldNow;

      assert.strictEqual(yield* SubscriptionRef.get(supervisor.status), "failed");
      yield* Effect.sync(() => crashChild(child));
    }).pipe(
      Effect.ensuring(Effect.sync(() => crashChild(child))),
      Effect.provide(supervisorTestLayer(supervisorOptions)),
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
      expect(child.killOptions).toEqual([{ killSignal: "SIGTERM", forceKillAfter: 0 }]);
      expect(child.unrefCount).toBe(1);
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

  it("finishes cleanup when stopping the child fails", async () => {
    const failure = PlatformError.systemError({
      module: "ChildProcess",
      method: "kill",
      _tag: "Unknown",
    });
    const child = new ShutdownOutputChild(null, failure);
    const entries: unknown[] = [];
    const capture = Logger.make(({ message }) => entries.push(message));

    await withSupervisor(
      options({ spawn: () => child }),
      async (runtime, supervisor) => {
        await runtime.runPromise(supervisor.start);
        await runtime.runPromise(supervisor.stop.pipe(Effect.timeout("1 second")));

        expect(child.unrefCount).toBe(1);
        expect(entries).toContainEqual(["Engine output", { line: "shutdown diagnostic", stream: "stderr" }]);
        expect(await currentStatus(runtime, supervisor)).toBe("stopped");
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

  it("logs output flushed before the child closes", async () => {
    const child = new FakeChild();
    const entries: unknown[] = [];
    const capture = Logger.make(({ message }) => entries.push(message));

    await withSupervisor(
      options({ maxRestarts: 0, spawn: () => child }),
      async (runtime, supervisor) => {
        const statuses = collectStatuses(runtime, supervisor, 4);
        await runtime.runPromise(supervisor.start);
        await yieldToSupervisor(runtime);
        queueMicrotask(() => {
          child.stdout.end();
          child.stderr.end("last diagnostic\n");
          child.close(1);
        });

        await statuses;
        expect(entries).toContainEqual(["Engine output", { line: "last diagnostic", stream: "stderr" }]);
      },
      Logger.layer([capture], { mergeWithExisting: false }),
    );
  });
});
