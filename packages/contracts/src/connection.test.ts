import { assert, describe, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  Connection,
  ConnectionEstablishment,
  ConnectionId,
  connectionIdOf,
  connectionSystemOf,
} from "./connection";

describe("Connection", () => {
  it("identifies one system account binding", () => {
    const id = connectionIdOf("linear", "acme");
    const connection = Schema.decodeSync(Connection)({
      id,
      system: "linear",
      account: "acme",
      status: "established",
    });

    assert.strictEqual(connection.id, "linear/acme");
    assert.strictEqual(connectionSystemOf(connection.id), "linear");
  });

  it("decodes API keys as redacted establishment input", () => {
    const establishment = Schema.decodeSync(ConnectionEstablishment)({
      system: "github",
      account: "default",
      source: { _tag: "ApiKey", key: "secret" },
    });

    assert.strictEqual(establishment.source._tag, "ApiKey");
    if (establishment.source._tag !== "ApiKey") return;
    assert.strictEqual(Redacted.value(establishment.source.key), "secret");
  });

  it("rejects ids without a known system and account", () => {
    const decode = Schema.decodeSync(ConnectionId);
    assert.throws(() => decode("unbound"));
    assert.throws(() => decode("linear/"));
    assert.throws(() => decode("unknown/acme"));
  });
});
