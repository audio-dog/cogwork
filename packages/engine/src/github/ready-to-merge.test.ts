import { LineageId, WorkflowActionArtifact } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import type { PrSignals } from "../source-control";
import type { RawPull } from "./client";
import { isReadyToMerge, readyToMergeArtifact } from "./provider";

const pull = (over: Partial<RawPull> = {}): RawPull => ({
  number: 1,
  url: "https://github.com/owner/repo/pull/1",
  authorLogin: "cogwork[bot]",
  authorAssociation: "MEMBER",
  draft: false,
  headSha: "sha",
  headRef: "1-x",
  headRepository: "owner/repo",
  closingIssueNumbers: [],
  updatedAtMillis: 0,
  ...over,
});

const signals = (over: Partial<PrSignals> = {}): PrSignals => ({
  number: 1,
  url: "https://github.com/owner/repo/pull/1",
  review: "ready",
  checks: "passing",
  baseDivergence: "none",
  waitingSinceMillis: 1,
  draft: false,
  ...over,
});

const artifact = Schema.decodeSync(WorkflowActionArtifact)({
  workspace: "workspace",
  issue: "#1",
  url: "https://github.com/owner/repo/pull/1",
  origin: {
    item: "issue:workspace:%231",
    workflow: "workflow",
    attempt: "run-1",
    writeKey: "write-1",
    lineage: { root: LineageId.make("issue:workspace:%231"), parent: null, hop: 0 },
  },
});

describe("ready to merge", () => {
  it("requires Cogwork origin", () => {
    assert.deepStrictEqual(readyToMergeArtifact(pull(), "cogwork[bot]", [artifact]), artifact);
    assert.isNull(readyToMergeArtifact(pull({ authorLogin: "person" }), "cogwork[bot]", [artifact]));
    assert.isNull(readyToMergeArtifact(pull({ number: 2 }), "cogwork[bot]", [artifact]));
  });

  it("requires a non-draft, green, conflict-free, approved pull request", () => {
    assert.isTrue(isReadyToMerge(signals()));
    [
      signals({ draft: true }),
      signals({ checks: "pending" }),
      signals({ checks: "failing" }),
      signals({ baseDivergence: "conflict" }),
      signals({ review: "pending" }),
      signals({ review: "changes-requested" }),
    ].forEach((candidate) => assert.isFalse(isReadyToMerge(candidate)));
  });
});
