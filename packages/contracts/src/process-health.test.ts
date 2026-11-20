import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { DesktopProcessHealthSample, ProcessHealthSample } from "./daemon";

const decode = Schema.decodeUnknownSync(ProcessHealthSample);

describe("ProcessHealthSample", () => {
  it("decodes bounded process measurements", () => {
    assert.deepStrictEqual(
      decode({
        process: "renderer",
        sampledAtMillis: 1_000,
        heapUsedBytes: 400,
        heapLimitBytes: 1_000,
        privateBytes: 800,
        protocolInboxDepth: 3,
        eventsAppliedPerSecond: 12.5,
      }),
      {
        process: "renderer",
        sampledAtMillis: 1_000,
        heapUsedBytes: 400,
        heapLimitBytes: 1_000,
        privateBytes: 800,
        protocolInboxDepth: 3,
        eventsAppliedPerSecond: 12.5,
      },
    );
  });

  it("rejects unknown processes and negative measurements", () => {
    assert.throws(() => decode({ process: "gpu", sampledAtMillis: 1 }));
    assert.throws(() => decode({ process: "main", sampledAtMillis: 1, ipcFramesToRendererPerSecond: -1 }));
  });

  it("keeps daemon samples off the desktop reporting boundary", () => {
    const decodeDesktop = Schema.decodeUnknownSync(DesktopProcessHealthSample);
    assert.throws(() => decodeDesktop({ process: "daemon", sampledAtMillis: 1 }));
  });
});
