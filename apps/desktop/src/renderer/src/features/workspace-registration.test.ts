import { describe, expect, it } from "vitest";
import { absoluteCheckoutPathFrom, workspaceRegistrationFrom } from "./workspace-registration";

const githubDraft = {
  checkoutPath: "/Users/taylor/sites/cogwork",
  tracker: "github" as const,
  issueTrackerConnectionId: "github/acme",
  linearTeams: "",
  linearOrganization: "",
  sourceControlConnectionId: "",
};

describe("absoluteCheckoutPathFrom", () => {
  it("trims absolute paths and refuses relative paths", () => {
    expect(absoluteCheckoutPathFrom("  /Users/taylor/sites/cogwork  ")).toBe("/Users/taylor/sites/cogwork");
    expect(absoluteCheckoutPathFrom("relative/path")).toBeNull();
  });
});

describe("workspaceRegistrationFrom", () => {
  it("builds a GitHub registration named for its checkout folder", () => {
    expect(
      workspaceRegistrationFrom({ ...githubDraft, checkoutPath: "  /Users/taylor/sites/cogwork/  " }),
    ).toEqual({
      name: "cogwork",
      checkoutPath: "/Users/taylor/sites/cogwork/",
      issueTracker: { type: "github", connectionId: "github/acme" },
      linearHistory: false,
    });
  });

  it("names a Windows checkout for its last folder", () => {
    expect(workspaceRegistrationFrom({ ...githubDraft, checkoutPath: "C:\\src\\cogwork" })?.name).toBe(
      "cogwork",
    );
  });

  it("builds a Linear registration with GitHub source control", () => {
    expect(
      workspaceRegistrationFrom({
        checkoutPath: "/Users/taylor/sites/cogwork",
        tracker: "linear",
        issueTrackerConnectionId: "linear/acme",
        linearTeams: "ENG, Platform, ENG",
        linearOrganization: "  colony  ",
        sourceControlConnectionId: "github/acme",
      }),
    ).toEqual({
      name: "cogwork",
      checkoutPath: "/Users/taylor/sites/cogwork",
      issueTracker: {
        type: "linear",
        connectionId: "linear/acme",
        teams: ["ENG", "Platform"],
        organization: "colony",
      },
      sourceControl: { type: "github", connectionId: "github/acme" },
      linearHistory: false,
    });
  });

  it("refuses an incomplete registration", () => {
    expect(workspaceRegistrationFrom({ ...githubDraft, checkoutPath: "relative/path" })).toBeNull();
    expect(workspaceRegistrationFrom({ ...githubDraft, issueTrackerConnectionId: "" })).toBeNull();
    expect(workspaceRegistrationFrom({ ...githubDraft, checkoutPath: "/" })).toBeNull();
  });
});
