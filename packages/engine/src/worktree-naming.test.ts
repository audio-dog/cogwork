import { assert, describe, it } from "@effect/vitest";

import { branchName, slugify, ticketSlug, worktreePathFor, worktreeRoot } from "./worktree";

describe("worktree naming", () => {
  it("strips the leading hash from a GitHub issue id", () => {
    assert.strictEqual(ticketSlug("#13"), "13");
  });

  it("kebab-cases a Linear-style id", () => {
    assert.strictEqual(ticketSlug("AUD-1"), "aud-1");
  });

  it("kebab-cases a title, collapsing punctuation and spaces", () => {
    assert.strictEqual(
      slugify("Worktree lifecycle: create, reuse, teardown & reaper"),
      "worktree-lifecycle-create-reuse-teardown-reaper",
    );
  });

  it("joins ticket and title into a branch name", () => {
    assert.strictEqual(
      branchName({ id: "#13", title: "Worktree lifecycle: create, reuse" }),
      "13-worktree-lifecycle-create-reuse",
    );
  });

  it("falls back to the bare ticket when the title has no usable characters", () => {
    assert.strictEqual(branchName({ id: "#42", title: "!!!" }), "42");
  });

  it("encodes a ticket id with no kebab characters", () => {
    assert.strictEqual(branchName({ id: "!!!", title: "💣" }), "u--0000x0000x0000x");
    assert.notStrictEqual(ticketSlug("!"), ticketSlug("x"));
  });

  it("defaults the worktree root to a sibling of the checkout", () => {
    assert.strictEqual(worktreeRoot("/repos/cogwork"), "/repos/cogwork.worktrees");
  });

  it("honours a configured root override", () => {
    assert.strictEqual(worktreeRoot("/repos/cogwork", { root: "/tmp/wt" }), "/tmp/wt");
  });

  it("normalizes a trailing slash on a configured root", () => {
    assert.strictEqual(worktreeRoot("/repos/cogwork", { root: "/tmp/wt/" }), "/tmp/wt");
  });

  it("places a worktree under the root by branch", () => {
    assert.strictEqual(worktreePathFor("/root", "13-x"), "/root/13-x");
  });
});
