import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { Harness } from "@cogwork/engine";
import { spawnHandleToAcpTransport } from "@tanstack/ai-acp";
import { localProcessSandbox } from "@tanstack/ai-sandbox-local-process";
import * as Effect from "effect/Effect";
import {
  catalogModels,
  decodeAvailableModels,
  listAvailableModelsMethod,
  parameterizedModelPickerCapability,
} from "./catalog";
import { cursorScrubEnv } from "./scrub-env";

export const missingCursorExecutable = /ENOENT|EACCES|command not found/i;

export const cursorProbeError = (cause: unknown) => {
  const message = String(cause);
  return new Harness.HarnessError({
    reason: missingCursorExecutable.test(message) ? "missing-harness" : "launch",
    retryable: false,
    message,
  });
};

// Well under the harness overview's own 10s probe budget, which this read sits inside.
const acpCatalogDeadline = "3 seconds";

const refuseSession = () => Promise.reject(new Error("the Cursor catalog probe runs no session"));

const refusingClient = { requestPermission: refuseSession, sessionUpdate: refuseSession };

const openConnection = Effect.fn("CursorRunner.openConnection")(function* (agentBin: string) {
  const sandbox = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => localProcessSandbox({ dir: process.cwd(), scrubEnv: [...cursorScrubEnv] }).create({}),
      catch: cursorProbeError,
    }),
    (open) => Effect.promise(() => open.destroy()),
  );
  const handle = yield* Effect.tryPromise({
    try: (signal) => sandbox.process.spawn(`${agentBin} acp`, { signal }),
    catch: cursorProbeError,
  });
  const bytes = yield* Effect.acquireRelease(
    Effect.sync(() => spawnHandleToAcpTransport(handle)),
    (open) => Effect.ignore(Effect.tryPromise({ try: () => open.kill(), catch: cursorProbeError })),
  );
  return new ClientSideConnection(() => refusingClient, ndJsonStream(bytes.writable, bytes.readable));
});

const availableModels = Effect.fn("CursorRunner.availableModels")(function* (agentBin: string) {
  const connection = yield* openConnection(agentBin);
  yield* Effect.tryPromise({
    try: () =>
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "cogwork", version: "0.0.0" },
        clientCapabilities: { _meta: parameterizedModelPickerCapability },
      }),
    catch: cursorProbeError,
  });
  const response = yield* Effect.tryPromise({
    try: () => connection.extMethod(listAvailableModelsMethod, {}),
    catch: cursorProbeError,
  });
  return yield* decodeAvailableModels(response).pipe(
    Effect.mapError(
      (error) =>
        new Harness.HarnessError({
          reason: "incompatible-harness",
          retryable: false,
          message: `Cursor answered ${listAvailableModelsMethod} in an unreadable shape. Update Cursor, then retry. (${error.message})`,
        }),
    ),
  );
});

export const cursorAcpCatalog = (agentBin: string, harnessVersion: () => Effect.Effect<string>) => ({
  catalog: Effect.gen(function* () {
    const response = yield* Effect.scoped(availableModels(agentBin)).pipe(Effect.timeout(acpCatalogDeadline));
    const models = catalogModels(response);
    if (models.length === 0) return null;
    return {
      models,
      provenance: {
        source: "native-discovery" as const,
        runtimeHost: "local-process",
        harnessVersion: yield* harnessVersion(),
      },
    };
  }).pipe(
    Effect.withSpan("CursorRunner.acpCatalog"),
    Effect.tapError((error) => Effect.logWarning("Cursor ACP model discovery failed", { error })),
    Effect.orElseSucceed(() => null),
  ),
});
