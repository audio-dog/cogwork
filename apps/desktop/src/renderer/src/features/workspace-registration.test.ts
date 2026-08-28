import { describe, expect, it } from "vitest";
import { absoluteCheckoutPathFrom, workspaceRegistrationFrom } from "./workspace-registration";

describe("absoluteCheckoutPathFrom", () => {
  it("trims absolute paths and refuses relative paths", () => {
    expect(absoluteCheckoutPathFrom("  /Users/taylor/sites/cogwork  ")).toBe("/Users/taylor/sites/cogwork");
    expect(absoluteCheckoutPathFrom("relative/path")).toBeNull();
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
