import { assert, it } from "@effect/vitest";
import type { SandboxHandle, SandboxProvider } from "@tanstack/ai-sandbox";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Effect from "effect/Effect";
import { abortOnReturn, ownSandboxHandles } from "./provider-bridge";

it.effect("waits for cleanup before returning the source iterator", () =>
  Effect.gen(function* () {
    const cleanup = Promise.withResolvers<void>();
    const returns: Array<true> = [];
    const source = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: false, value: "event" }),
        return: () => {
          returns.push(true);
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    };
    const iterator = abortOnReturn(source, () => cleanup.promise)[Symbol.asyncIterator]();
    const closing = iterator.return();

    yield* Effect.promise(() => Promise.resolve());
    assert.deepStrictEqual(returns, []);

    cleanup.resolve();
    yield* Effect.promise(() => closing);
    assert.deepStrictEqual(returns, [true]);
  }),
);

it.effect("awaits the live handle when the provider destroys its sandbox", () =>
  Effect.gen(function* () {
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const completions: Array<true> = [];
    const source = localProcessSandbox({ dir: process.cwd() });
    const provider = {
      name: source.name,
      capabilities: () => source.capabilities(),
      create: (input: Parameters<SandboxProvider["create"]>[0]) =>
        source.create(input).then(
          (handle) =>
            ({
              ...handle,
              destroy: () => {
                started.resolve();
                return release.promise;
              },
            }) satisfies SandboxHandle,
        ),
      resume: () => Promise.resolve(null),
      destroy: () => Promise.resolve(),
    } satisfies SandboxProvider;
    const owned = ownSandboxHandles(provider);
    const handle = yield* Effect.promise(() => owned.provider.create({}));
    const destroying = owned.provider.destroy({ id: handle.id }).then(() => completions.push(true));

    yield* Effect.promise(() => started.promise);
    assert.deepStrictEqual(completions, []);

    release.resolve();
    yield* Effect.promise(() => destroying);
    assert.deepStrictEqual(completions, [true]);
  }),
);
