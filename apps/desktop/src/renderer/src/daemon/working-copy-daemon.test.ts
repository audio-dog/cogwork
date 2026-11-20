import { DaemonRpcs, PrincipalId, WorkflowDocument, WorkflowId, WorkflowRecord } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Ref from "effect/Ref";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RequestEncoded } from "effect/rpc/RpcMessage";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Schema from "effect/Schema";

import { DaemonAtomRpc } from "./atoms";
import { layer as productionLayer, WorkingCopyDaemon } from "./working-copy-daemon";

const workflowId = Schema.decodeUnknownSync(WorkflowId)("workflow-1");

const reply: WorkflowRecord = {
  id: workflowId,
  principal: Schema.decodeUnknownSync(PrincipalId)("person"),
  workingCopy: Schema.decodeUnknownSync(WorkflowDocument)({
    name: "Triage",
    workspaces: { _tag: "Every" },
    triggers: [],
    operations: [],
  }),
  workingRevision: 2,
  publishedCopy: null,
  publishedRevision: null,
  enabled: false,
  diagnostics: [],
  readiness: [],
};

class SentRequests extends Context.Service<SentRequests, Ref.Ref<ReadonlyArray<RequestEncoded>>>()(
  "@cogwork/desktop/daemon/working-copy-daemon.test/SentRequests",
) {}

const encodeReply = Schema.encodeSync(Schema.toCodecJson(WorkflowRecord));

const memoryProtocol = Layer.effect(RpcClient.Protocol)(
  Effect.gen(function* () {
    const sent = yield* SentRequests;
    const { codecFor } = yield* RpcSerialization.RpcSerialization;
    return yield* RpcClient.Protocol.make((write) =>
      Effect.succeed({
        send: (clientId, request) =>
          request._tag === "Request"
            ? Ref.update(sent, (requests) => [...requests, request]).pipe(
                Effect.andThen(
                  write(clientId, {
                    _tag: "Exit",
                    requestId: request.id,
                    exit: { _tag: "Success", value: encodeReply(reply) },
                  }),
                ),
              )
            : Effect.void,
        supportsAck: false,
        supportsTransferables: false,
        codecFor,
      }),
    );
  }),
);

const contractLayer = productionLayer.pipe(
  Layer.provide(Layer.effect(DaemonAtomRpc)(RpcClient.make(DaemonRpcs, { flatten: true }))),
  Layer.provide(memoryProtocol),
  Layer.provide(AtomRegistry.layer),
  Layer.provide(RpcSerialization.layerJson),
  Layer.provideMerge(Layer.effect(SentRequests)(Ref.make<ReadonlyArray<RequestEncoded>>([]))),
);

describe("WorkingCopyDaemon over the daemon RPC contract", () => {
  it.effect("sends the encoded batch and answers with the decoded record", () =>
    Effect.gen(function* () {
      const daemon = yield* WorkingCopyDaemon;

      const record = yield* daemon.edit(workflowId, [{ _tag: "Rename", name: "Triage" }]);

      assert.deepStrictEqual(record, reply);
      assert.deepStrictEqual(
        (yield* Ref.get(yield* SentRequests)).map(({ tag, payload }) => ({ tag, payload })),
        [{ tag: "EditWorkflow", payload: { id: workflowId, edits: [{ _tag: "Rename", name: "Triage" }] } }],
      );
    }).pipe(Effect.provide(contractLayer)),
  );

  it.effect("dies before it sends a batch the contract cannot encode, as the in-memory daemon does", () =>
    Effect.gen(function* () {
      const daemon = yield* WorkingCopyDaemon;

      const exit = yield* Effect.exit(daemon.edit(workflowId, [{ _tag: "Rename", name: "Triage " }]));

      assert.isTrue(Exit.hasDies(exit));
      assert.deepStrictEqual(yield* Ref.get(yield* SentRequests), []);
    }).pipe(Effect.provide(contractLayer)),
  );
});
