import * as Cause from "effect/Cause";
import { RpcClientDefect, RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { describe, expect, it } from "vitest";
import { daemonErrorMessage } from "./daemon-error";

const closedError = new RpcClientError({
  reason: new RpcClientDefect({ message: "The daemon connection closed", cause: null }),
});

describe("daemonErrorMessage", () => {
  it("reads the reason message from a transport RpcClientError", () => {
    expect(daemonErrorMessage(Cause.fail(closedError))).toBe("The daemon connection closed");
  });

  it("does not throw on a cause that would break Cause.pretty", () => {
    const streamCompletionSignal = {
      "~effect/Cause/Done": "~effect/Cause/Done",
      _tag: "Done",
      value: undefined,
    };
    const withNestedDone = new RpcClientError({
      reason: new RpcClientDefect({ message: "Could not reach the daemon", cause: streamCompletionSignal }),
    });
    expect(daemonErrorMessage(Cause.fail(withNestedDone))).toBe("Could not reach the daemon");
  });

  it("reads a plain Error defect", () => {
    expect(daemonErrorMessage(Cause.die(new Error("boom")))).toBe("boom");
  });

  it("falls back to a readable sentence for an unknown defect", () => {
    expect(daemonErrorMessage(Cause.die({ shape: "unexpected" }))).toBe(
      "The daemon is unreachable. Check that the engine is running and try again.",
    );
  });
});
