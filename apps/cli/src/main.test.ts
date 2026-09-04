import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

it.live(
  "ignores an existing ~/.cogwork/.env",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "cogwork-home-" });
      const envFile = path.join(home, ".cogwork", ".env");
      yield* fs.makeDirectory(path.dirname(envFile), { recursive: true });
      yield* fs.writeFileString(envFile, "OPENAI_API_KEY=from-file\n");
      yield* fs.chmod(envFile, 0o000);

      const child = yield* ChildProcess.make(
        path.resolve("node_modules/.bin/tsx"),
        ["src/main.ts", "--help"],
        {
          cwd: process.cwd(),
          env: { HOME: home },
          extendEnv: true,
        },
      );
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode, Stream.mkString(Stream.decodeText(child.stderr))],
        { concurrency: "unbounded" },
      ).pipe(Effect.timeout("15 seconds"));

      assert.strictEqual(Number(exitCode), 0, stderr);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  20_000,
);
