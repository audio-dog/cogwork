import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";
import { CreateWorkflow, EditWorkflow } from "./rpc";

const decodeWirePayload = (rpc: typeof CreateWorkflow | typeof EditWorkflow, payload: unknown) => {
  const decoded = Schema.decodeUnknownExit(
    Schema.toCodecJson(rpc.payloadSchema),
    Context.get(rpc.annotations, Rpc.ParseOptions),
  )(payload);
  return Exit.isSuccess(decoded) ? "accepted" : Cause.pretty(decoded.cause);
};

const document = { name: "Triage", workspaces: { _tag: "Every" }, triggers: [], operations: [] };
const rename = { _tag: "Rename", name: "Edited" };

describe("Workflow RPC payloads", () => {
  it("accepts a Workflow document and edit that declare every key", () => {
    assert.strictEqual(decodeWirePayload(CreateWorkflow, { document }), "accepted");
    assert.strictEqual(decodeWirePayload(EditWorkflow, { id: "triage", edits: [rename] }), "accepted");
  });

  it("refuses keys that a Workflow document or edit does not declare", () => {
    assert.include(
      decodeWirePayload(CreateWorkflow, { document: { ...document, extra: true } }),
      'Expected no excess property\n  at ["document"]["extra"]',
    );
    assert.include(
      decodeWirePayload(EditWorkflow, { id: "triage", edits: [{ ...rename, extra: true }] }),
      'Expected no excess property\n  at ["edits"][0]["extra"]',
    );
  });
});
