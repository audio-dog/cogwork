import { initialBoard } from "@cogwork/contracts";
import { describe, expect, it } from "vitest";

import { BoardResult } from "./activity-session";
import { brokenReason, treatmentFor } from "./engine-gate";
import type { EnginePhase } from "./use-engine-status";

const initial = BoardResult.Initial();
const failure = BoardResult.Failure();
const success = BoardResult.Success({ board: initialBoard, previews: new Map() });
const boards = [initial, failure, success];

describe("treatmentFor", () => {
  it("is Off whenever the engine is off, whatever the stream is doing", () => {
    for (const board of boards) {
      expect(treatmentFor("off", board)).toBe("off");
    }
  });

  it("is Broken whenever the engine failed, whatever the stream is doing", () => {
    for (const board of boards) {
      expect(treatmentFor("failed", board)).toBe("broken");
    }
  });

  it("is Connecting whenever the engine is still starting, whatever the stream is doing", () => {
    for (const board of boards) {
      expect(treatmentFor("starting", board)).toBe("connecting");
    }
  });

  it("is Live only when the engine is up and the stream has a board", () => {
    expect(treatmentFor("up", success)).toBe("live");
  });

  it("is Connecting when the engine is up but the stream has not seeded yet", () => {
    expect(treatmentFor("up", initial)).toBe("connecting");
  });

  it("is Broken when the engine claims it is up but the stream has failed", () => {
    expect(treatmentFor("up", failure)).toBe("broken");
  });

  it("lets engine phase win over the stream result", () => {
    expect(treatmentFor("off", success)).toBe("off");
    expect(treatmentFor("failed", success)).toBe("broken");
    expect(treatmentFor("starting", failure)).toBe("connecting");
  });
});

describe("brokenReason", () => {
  it("names the engine failing when the phase is failed", () => {
    expect(brokenReason("failed")).toBe("engine-failed");
  });

  it("names the daemon unreachable for every other phase (stream failed while up)", () => {
    const phases: readonly EnginePhase[] = ["off", "starting", "up"];
    for (const phase of phases) {
      expect(brokenReason(phase)).toBe("daemon-unreachable");
    }
  });
});
