import { WorkspaceState } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  absoluteCheckoutPathFrom,
  workspaceOutcomeError,
  workspaceRegistrationFrom,
  workspaceSubmissionStatus,
} from "./workspace-registration";

describe("absoluteCheckoutPathFrom", () => {
  it("trims absolute paths and refuses relative paths", () => {
    expect(absoluteCheckoutPathFrom("  /Users/taylor/sites/cogwork  ")).toBe("/Users/taylor/sites/cogwork");
    expect(absoluteCheckoutPathFrom("relative/path")).toBeNull();
  });
});

describe("workspaceSubmissionStatus", () => {
  it("ignores an atom result until this dialog submits", () => {
    expect(
      workspaceSubmissionStatus({
        submitted: false,
        pending: false,
        error: null,
        outcomeError: null,
        outcome: {},
      }),
    ).toBe("idle");
  });

  it("blocks repeat submission until a failure permits retry", () => {
    expect(
      workspaceSubmissionStatus({
        submitted: true,
        pending: false,
        error: null,
        outcomeError: null,
        outcome: null,
      }),
    ).toBe("submitting");
    expect(
      workspaceSubmissionStatus({
        submitted: true,
        pending: false,
        error: "failed",
        outcomeError: null,
        outcome: null,
      }),
    ).toBe("failed");
    expect(
      workspaceSubmissionStatus({
        submitted: true,
        pending: false,
        error: null,
        outcomeError: null,
        outcome: {},
      }),
    ).toBe("complete");
  });

  it("treats a failed command outcome as retryable", () => {
    expect(
      workspaceSubmissionStatus({
        submitted: true,
        pending: false,
        error: null,
        outcomeError: "Workspace input failed",
        outcome: {},
      }),
    ).toBe("failed");
  });
});

describe("workspaceOutcomeError", () => {
  it("returns the input failure from a failed workspace outcome", () => {
    const outcome = Schema.decodeSync(WorkspaceState)({
      _tag: "Failed",
      source: "/Users/taylor/sites/cogwork/CONTEXT.md",
      message: "Workspace input failed",
    });

    expect(workspaceOutcomeError(outcome)).toBe("Workspace input failed");
  });
});

describe("workspaceRegistrationFrom", () => {
  it("builds a GitHub registration from the surface form", () => {
    expect(
      workspaceRegistrationFrom({
        name: "  Cogwork  ",
        checkoutPath: "  /Users/taylor/sites/cogwork  ",
        gitRemote: "  git@github.com:colonylabs/cogwork.git  ",
        tracker: "github",
        repository: "  colonylabs/cogwork  ",
        linearTeams: "",
        linearOrganization: "",
        sourceControlRepository: "",
      }),
    ).toEqual({
      name: "Cogwork",
      checkoutPath: "/Users/taylor/sites/cogwork",
      gitRemote: "git@github.com:colonylabs/cogwork.git",
      issueTracker: { type: "github", repo: "colonylabs/cogwork" },
      linearHistory: false,
    });
  });

  it("builds a Linear registration with GitHub source control", () => {
    expect(
      workspaceRegistrationFrom({
        name: "cogwork",
        checkoutPath: "/Users/taylor/sites/cogwork",
        gitRemote: "",
        tracker: "linear",
        repository: "",
        linearTeams: "ENG, Platform, ENG",
        linearOrganization: "  colony  ",
        sourceControlRepository: " colonylabs/cogwork ",
      }),
    ).toEqual({
      name: "cogwork",
      checkoutPath: "/Users/taylor/sites/cogwork",
      issueTracker: { type: "linear", teams: ["ENG", "Platform"], organization: "colony" },
      sourceControl: { type: "github", repo: "colonylabs/cogwork" },
      linearHistory: false,
    });
  });

  it("refuses an incomplete registration", () => {
    expect(
      workspaceRegistrationFrom({
        name: "",
        checkoutPath: "relative/path",
        gitRemote: "",
        tracker: "github",
        repository: "",
        linearTeams: "",
        linearOrganization: "",
        sourceControlRepository: "",
      }),
    ).toBeNull();
  });
});
