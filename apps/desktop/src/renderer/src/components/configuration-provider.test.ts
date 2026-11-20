import { type ContributionSettingUpdate, type ControlStore, initialBoard } from "@cogwork/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { describe, expect, it } from "vitest";

import { BoardResult } from "../features/activity-session";
import { contributionSettingState, retainConfigurationBoard } from "./configuration-provider";

const contribution = { id: "repo-tools", kind: "mcp-server" } as const;
const update = {
  _tag: "Set",
  row: {
    contribution,
    scope: { _tag: "SettingsProfile" },
    enabled: true,
  },
} satisfies ContributionSettingUpdate;

const picture = (enabled: boolean): ControlStore => ({
  daemonLimits: {
    globalConcurrency: 4,
    perWorkspaceConcurrency: 4,
    dailyBudget: 50,
    revision: 0,
  },
  connections: [],
  harnessSettings: [],
  contributionSettings: [
    {
      contribution,
      scope: { _tag: "SettingsProfile" },
      enabled,
    },
  ],
  operationSettings: [],
  pluginInstalls: [],
});

describe("contributionSettingState", () => {
  it("keeps the submitted value until the published board catches up", () => {
    const board = picture(false);
    const previousResult = AsyncResult.initial<ControlStore>();
    const submission = { baseline: board, update, previousResult };

    const pending = contributionSettingState(board, AsyncResult.initial<ControlStore>(true), submission);
    expect(pending.controlStore?.contributionSettings[0]?.enabled).toBe(true);
    expect(pending.waiting).toBe(true);
    expect(pending.settled).toBe(false);

    const unrelated = contributionSettingState(
      picture(false),
      AsyncResult.initial<ControlStore>(true),
      submission,
    );
    expect(unrelated.controlStore?.contributionSettings[0]?.enabled).toBe(true);
    expect(unrelated.waiting).toBe(true);
    expect(unrelated.settled).toBe(false);

    const written = picture(true);
    const returned = contributionSettingState(board, AsyncResult.success(written), submission);
    expect(returned.controlStore).toBe(written);
    expect(returned.waiting).toBe(true);
    expect(returned.settled).toBe(false);

    const published = picture(true);
    expect(contributionSettingState(published, AsyncResult.initial<ControlStore>(true), submission)).toEqual({
      controlStore: published,
      waiting: true,
      settled: true,
    });
    expect(contributionSettingState(published, AsyncResult.success(written), submission)).toEqual({
      controlStore: published,
      waiting: false,
      settled: true,
    });

    const newer = picture(false);
    expect(contributionSettingState(newer, AsyncResult.success(written), null).controlStore).toBe(newer);
  });

  it("does not reuse the atom result from before submission", () => {
    const board = picture(false);
    const previousResult = AsyncResult.success(picture(false));
    const state = contributionSettingState(board, previousResult, {
      baseline: board,
      update,
      previousResult,
    });

    expect(state.controlStore?.contributionSettings[0]?.enabled).toBe(true);
    expect(state.waiting).toBe(true);
    expect(state.settled).toBe(false);
  });

  it("reverts a failed write", () => {
    const board = picture(false);
    const previousResult = AsyncResult.initial<ControlStore>();
    const failed = AsyncResult.fail(new Error("write failed"));
    expect(contributionSettingState(board, failed, { baseline: board, update, previousResult })).toEqual({
      controlStore: board,
      waiting: false,
      settled: true,
    });
  });
});

describe("retainConfigurationBoard", () => {
  it("keeps the last live board through reconnecting and lost states", () => {
    const live = { ...initialBoard, controlStore: picture(false) };
    const replacement = { ...initialBoard, controlStore: picture(true) };

    expect(retainConfigurationBoard(null, BoardResult.Initial())).toBeNull();
    expect(retainConfigurationBoard(live, BoardResult.Initial())).toBe(live);
    expect(retainConfigurationBoard(live, BoardResult.Failure())).toBe(live);
    expect(
      retainConfigurationBoard(live, BoardResult.Success({ board: replacement, previews: new Map() })),
    ).toBe(replacement);
  });
});
