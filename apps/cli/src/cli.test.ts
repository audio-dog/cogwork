import { OperationSettingRefused } from "@cogwork/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Command from "effect/cli/Command";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { RpcClientError } from "effect/rpc/RpcClientError";
import { SocketCloseError } from "effect/socket/Socket";
import { TestConsole } from "effect/testing";
import { cli } from "./cli";
import { reportDaemonTransportError } from "./commands";
import { operationSettingError } from "./operation-settings-commands";

layer(
  Layer.mergeAll(
    FetchHttpClient.layer,
    NodeServices.layer,
    NodeCrypto.layerSecureRandom,
    NodeCrypto.layerDigest,
  ),
)((it) => {
  it.effect("offers every Workflow RPC command", () =>
    Effect.gen(function* () {
      yield* Command.runWith(cli, { version: "0.0.1" })(["workflow", "--help"]);

      const output = (yield* TestConsole.logLines).join("\n");
      ["create", "edit", "publish", "switch", "delete", "list", "get", "validate", "catalog"].forEach(
        (command) => {
          assert.include(output, command);
        },
      );
    }),
  );

  it.effect("refuses Workflow edits with keys the edit does not declare", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Command.runWith(cli, { version: "0.0.1" })([
          "workflow",
          "edit",
          "triage",
          '[{"_tag":"Rename","name":"Edited","extra":true}]',
        ]),
      );

      assert.strictEqual(failure._tag, "UserError");
      if (failure._tag !== "UserError") return assert.fail("expected a user error");
      assert.include(failure.userMessage, "Invalid Workflow edits JSON");
    }),
  );

  it.effect("does not offer BYOK model listing while its Harness is unregistered", () =>
    Effect.gen(function* () {
      yield* Command.runWith(cli, { version: "0.0.1" })(["--help"]);

      assert.notInclude((yield* TestConsole.logLines).join("\n"), "models");
    }),
  );

  it.effect("points the retired effort setting at model-options", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Command.runWith(cli, { version: "0.0.1" })(["operation-settings", "set", "effort", "high"]),
      );

      assert.strictEqual(failure._tag, "ShowHelp");
      if (failure._tag !== "ShowHelp") return assert.fail("expected command help");
      const error = failure.errors[0];
      assert.strictEqual(error?._tag, "InvalidValue");
      if (error?._tag !== "InvalidValue") return assert.fail("expected invalid setting value");
      assert.strictEqual(error.value, "effort");
      assert.include(error.expected, "model-options");
    }),
  );

  it.effect("renders a refusal without a daemon reachability error", () =>
    Effect.gen(function* () {
      const refusal = OperationSettingRefused.make({
        setting: "model-options",
        source: "Harness cursor",
        reason: 'invalid effort; permitted model options: effort ("high")',
      });
      const error = operationSettingError(refusal);
      const command = Command.make("test", {}, () =>
        Effect.fail(error).pipe(
          Effect.tapError((failure) => reportDaemonTransportError("test.sock", failure)),
        ),
      );

      const failure = yield* Effect.flip(Command.runWith(command, { version: "0.0.1" })([]));

      assert.strictEqual(failure, error);
      const output = (yield* TestConsole.errorLines).join("\n");
      assert.include(output, 'permitted model options: effort ("high")');
      assert.notInclude(output, "Could not reach cogwork daemon");
    }),
  );

  it.effect("reports a daemon connection that closes during an RPC", () =>
    Effect.gen(function* () {
      const error = new RpcClientError({
        reason: new SocketCloseError({ code: 1006, closeReason: "connection lost" }),
      });

      yield* reportDaemonTransportError("test.sock", error);

      assert.include(
        (yield* TestConsole.errorLines).join("\n"),
        "Could not reach cogwork daemon at test.sock",
      );
    }),
  );
});
