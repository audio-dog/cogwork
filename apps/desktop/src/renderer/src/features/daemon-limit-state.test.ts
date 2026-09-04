import type { ControlStore } from "@cogwork/contracts";
import { describe, expect, it } from "vitest";
import { currentControlStore } from "./daemon-limit-state";

const picture = (revision: number, globalConcurrency: number): ControlStore => ({
  daemonLimits: {
    globalConcurrency,
    perWorkspaceConcurrency: 4,
    dailyBudget: 50,
    revision,
  },
  operationSettings: [],
  connections: [],
  pluginInstalls: [],
  harnessSettings: [],
  contributionSettings: [],
});

describe("currentControlStore", () => {
  it("uses the returned write until the event board catches up", () => {
    const board = picture(0, 4);
    const written = picture(1, 8);

    expect(currentControlStore(board, written, 0)).toBe(written);
    expect(currentControlStore(picture(1, 8), written, 0)).not.toBe(written);
  });

  it("keeps the last accepted result during a newer write", () => {
    const board = picture(0, 4);
    const written = picture(1, 8);

    expect(currentControlStore(board, written, 1)).toBe(written);
  });

  it("ignores a result left by a prior mount", () => {
    const board = picture(0, 4);
    const written = picture(1, 8);

    expect(currentControlStore(board, written, null)).toBe(board);
  });

  it("prefers a newer event board", () => {
    const board = picture(2, 10);
    expect(currentControlStore(board, picture(1, 8), 0)).toBe(board);
  });
});
