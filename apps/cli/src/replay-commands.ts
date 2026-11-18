import { RunId } from "@cogwork/contracts";
import { Replay } from "@cogwork/engine";
import * as Console from "effect/Console";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { defaultSocketPath } from "./paths";
import { clientLayer, makeDaemonClient } from "./rpc";

const socketFlag = Flag.String("socket").pipe(
  Flag.withDescription("Path to the daemon control socket"),
  Flag.withDefault(defaultSocketPath),
);
const runIdFlag = Flag.String("id").pipe(Flag.withDescription("Run id to export"));
const outputFlag = Flag.String("output").pipe(Flag.withDescription("Fixture file to write"));
const baseFlag = Flag.String("base").pipe(Flag.withDescription("Base replay report"));
const headFlag = Flag.String("head").pipe(Flag.withDescription("Head replay report"));
const reportMaxBytes = 16 * 1024 * 1024;
const fixtureFileMode = 0o600;
const replayFileDeadline = "5 seconds";
const decodeRunId = Schema.decodeEffect(RunId);

class ReplayReportTooLarge extends Data.TaggedError("ReplayReportTooLarge")<{
  readonly file: string;
  readonly maxBytes: number;
}> {
  override get message() {
    return `Replay report ${this.file} exceeds ${this.maxBytes} bytes`;
  }
}

class EmptyReplayFixture extends Data.TaggedError("EmptyReplayFixture")<{
  readonly runId: RunId;
  readonly eventsPrunedAtMillis: number | null;
}> {
  override get message() {
    if (this.eventsPrunedAtMillis !== null)
      return `Run ${this.runId} history was pruned at ${this.eventsPrunedAtMillis}`;
    return `Run ${this.runId} has no events to export`;
  }
}

class ReplayFileError extends Data.TaggedError("ReplayFileError")<{
  readonly message: string;
}> {}

const replayFileFailure = (message: string) => new ReplayFileError({ message });

const withReplayFileDeadline = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeoutMessage: string,
  failure: (error: E) => ReplayFileError,
) =>
  effect.pipe(
    Effect.mapError(failure),
    Effect.timeout(replayFileDeadline),
    Effect.catchTag("TimeoutError", () => replayFileFailure(timeoutMessage)),
  );

const readBoundedFile = Effect.fn("replay.readBoundedFile")(function* (
  file: string,
  maxBytes: number,
  tooLarge: (file: string, maxBytes: number) => ReplayReportTooLarge,
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* withReplayFileDeadline(fs.stat(file), `Timed out while inspecting ${file}`, () =>
    replayFileFailure(`Could not inspect ${file}`),
  );
  if (info.size > maxBytes) return yield* tooLarge(file, maxBytes);
  return yield* withReplayFileDeadline(fs.readFileString(file), `Timed out while reading ${file}`, () =>
    replayFileFailure(`Could not read ${file}`),
  );
});

const writeFixture = Effect.fn("replay.writeFixture")(function* (options: {
  readonly id: string;
  readonly output: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = yield* makeDaemonClient();
  const id = yield* decodeRunId(options.id);
  const { events, eventsPrunedAtMillis } = yield* client.GetRunEvents({ id });
  if (events.length === 0) return yield* new EmptyReplayFixture({ runId: id, eventsPrunedAtMillis });
  const encoded = yield* Replay.encodeReplayFixture(
    Replay.ReplayFixture.make({ version: 1, sourceRunId: id, events }),
  );
  const directory = path.dirname(options.output);
  const pending = path.join(
    directory,
    `.${path.basename(options.output)}.${SecureRandom.uuidV4Unsafe()}.pending`,
  );
  yield* withReplayFileDeadline(
    fs
      .makeDirectory(directory, { recursive: true })
      .pipe(
        Effect.andThen(fs.writeFileString(pending, `${encoded}\n`, { flag: "w", mode: fixtureFileMode })),
        Effect.andThen(fs.chmod(pending, fixtureFileMode)),
        Effect.andThen(fs.rename(pending, options.output)),
        Effect.ensuring(fs.remove(pending, { force: true }).pipe(Effect.ignore)),
      ),
    `Timed out while writing ${options.output}`,
    () => replayFileFailure(`Could not write ${options.output}`),
  );
  yield* Console.log(`Exported ${events.length} events to ${options.output}`);
});

export const exportReplayFixture = Effect.fn("replay.exportFixture")(function* (options: {
  readonly socket: string;
  readonly id: string;
  readonly output: string;
}) {
  return yield* writeFixture(options).pipe(Effect.scoped, Effect.provide(clientLayer(options.socket)));
});

const readReport = Effect.fn("replay.readReport")(function* (file: string) {
  return yield* readBoundedFile(
    file,
    reportMaxBytes,
    (path, maxBytes) => new ReplayReportTooLarge({ file: path, maxBytes }),
  ).pipe(Effect.flatMap(Replay.decodeReplayReport));
});

export const compareReplayFiles = Effect.fn("replay.compare")(function* (options: {
  readonly base: string;
  readonly head: string;
}) {
  const [base, head] = yield* Effect.all([readReport(options.base), readReport(options.head)]);
  const comparison = yield* Replay.compareReplayReports(base, head);
  yield* Console.log(Replay.formatReplayComparison(comparison));
});

const exportCommand = Command.make("export", {
  socket: socketFlag,
  id: runIdFlag,
  output: outputFlag,
}).pipe(
  Command.withDescription("Export one run as a replay fixture"),
  Command.withHandler(exportReplayFixture),
);

const compareCommand = Command.make("compare", { base: baseFlag, head: headFlag }).pipe(
  Command.withDescription("Compare replay counts and timing distributions"),
  Command.withHandler(compareReplayFiles),
);

export const replayCommand = Command.make("replay").pipe(
  Command.withDescription("Export and score replay-harness data"),
  Command.withSubcommands([exportCommand, compareCommand]),
);
