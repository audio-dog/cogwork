import type { PrSummary } from "@cogwork/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PullRequest } from "./pull-request";

const now = 120_000;

const pullRequest = (baseDivergence: PrSummary["baseDivergence"]): PrSummary => ({
  number: 7,
  url: "https://example.test/pull/7",
  checks: "passing",
  review: "ready",
  baseDivergence,
  waitingSinceMillis: 0,
});

describe("PullRequest", () => {
  it("shows the PR status, wait time, and code-host action", () => {
    const markup = renderToStaticMarkup(<PullRequest pr={pullRequest("clean")} now={now} />);

    expect(markup).toContain("PR #7");
    expect(markup).toContain("waiting 2m ago");
    expect(markup).toContain("Checks passing");
    expect(markup).toContain("Ready to merge");
    expect(markup).toContain("Behind base");
    expect(markup).toContain('href="https://example.test/pull/7"');
    expect(markup).toContain("Open on GitHub");
  });

  it("hides the base-divergence badge when there is none", () => {
    const markup = renderToStaticMarkup(<PullRequest pr={pullRequest("none")} now={now} />);

    expect(markup).not.toContain("Conflicts");
    expect(markup).not.toContain("Behind base");
  });
});
