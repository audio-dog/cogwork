import type { PrSummary } from "@cogwork/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PullRequest } from "./pull-request";

const now = 120_000;
const title = "Item tab: Pull request sub-tab";

const pullRequest = (baseDivergence: PrSummary["baseDivergence"]): PrSummary => ({
  number: 7,
  url: "https://example.test/pull/7",
  checks: "passing",
  review: "ready",
  baseDivergence,
  waitingSinceMillis: 0,
});

describe("PullRequest", () => {
  it("shows the PR status, wait time, and linked title", () => {
    const markup = renderToStaticMarkup(<PullRequest pr={pullRequest("clean")} now={now} title={title} />);

    expect(markup).toContain("PR #7");
    expect(markup).toContain("waiting 2m ago");
    expect(markup).toContain("Checks passing");
    expect(markup).toContain("Ready to merge");
    expect(markup).toContain("Behind base");
    expect(markup).toContain(
      '<a href="https://example.test/pull/7" rel="noreferrer" target="_blank">Item tab: Pull request sub-tab</a>',
    );
    expect(markup).not.toContain("Open on GitHub");
  });

  it("shows the up-to-date base state when there is no divergence", () => {
    const markup = renderToStaticMarkup(<PullRequest pr={pullRequest("none")} now={now} title={title} />);

    expect(markup).toContain("Up to date");
    expect(markup).not.toContain("Conflicts");
    expect(markup).not.toContain("Behind base");
  });

  it("uses collapsible Description, Checks, Activity, and current-status sections", () => {
    const markup = renderToStaticMarkup(<PullRequest pr={pullRequest("clean")} now={now} title={title} />);

    expect(markup).toContain("Description");
    expect(markup).toContain("Checks");
    expect(markup).toContain("Activity");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("Current status");
  });
});
