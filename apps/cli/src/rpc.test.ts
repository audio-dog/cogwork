import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import { defaultSocketPath } from "./paths";
import { transportLayer } from "./rpc";

describe("daemon socket", () => {
  it.effect("lives under the ~/.cogwork home", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      assert.strictEqual(path.basename(path.dirname(defaultSocketPath)), ".cogwork");
      assert.strictEqual(path.basename(defaultSocketPath), "cogwork.sock");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("binds a 0600 socket inside a freshly created 0700 directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "cf-" });
      const dir = path.join(home, "home");
      const socketPath = path.join(dir, "d.sock");

      yield* Effect.gen(function* () {
        assert.strictEqual((yield* fs.stat(socketPath)).mode & 0o777, 0o600);
        assert.strictEqual((yield* fs.stat(dir)).mode & 0o777, 0o700);
      }).pipe(
        Effect.provide(transportLayer(socketPath).pipe(Layer.provide(RpcSerialization.layerNdjson))),
        Effect.scoped,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("tightens a pre-existing loose socket directory to 0700", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "cf-" });
      const dir = path.join(home, "home");
      const socketPath = path.join(dir, "d.sock");
      yield* fs.makeDirectory(dir, { mode: 0o755 });

      yield* Effect.gen(function* () {
        assert.strictEqual((yield* fs.stat(dir)).mode & 0o777, 0o700);
      }).pipe(
        Effect.provide(transportLayer(socketPath).pipe(Layer.provide(RpcSerialization.layerNdjson))),
        Effect.scoped,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("releases the socket on scope teardown, leaving nothing to leak", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "cf-" });
      const dir = path.join(home, "home");
      const socketPath = path.join(dir, "d.sock");

      yield* Effect.gen(function* () {
        assert.isTrue(yield* fs.exists(socketPath));
      }).pipe(
        Effect.provide(transportLayer(socketPath).pipe(Layer.provide(RpcSerialization.layerNdjson))),
        Effect.scoped,
      );

      assert.isFalse(yield* fs.exists(socketPath));

      yield* Effect.void.pipe(
        Effect.provide(transportLayer(socketPath).pipe(Layer.provide(RpcSerialization.layerNdjson))),
        Effect.scoped,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
