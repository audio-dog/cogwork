import type { ControlStore, DaemonStatus, WorkspaceInfo } from "@cogwork/contracts";
import { HarnessName, IssueTrackerType, LineageId, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { formatOfflineStatus, formatStatus, formatStatusWithStore } from "./status";

const workItemId = Schema.decodeSync(WorkItemId);
const workspaceId = Schema.decodeSync(WorkspaceId);
const _harnessName = Schema.decodeSync(HarnessName);
const issueTrackerType = Schema.decodeSync(IssueTrackerType);
const lineageId = Schema.decodeSync(LineageId);

const workspace = (over: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  name: workspaceId("cogwork"),
  checkoutPath: "/tmp/cogwork",
  issueTracker: issueTrackerType("github"),
  record: {
    name: "cogwork",
    checkoutPath: "/tmp/cogwork",
    issueTracker: { type: issueTrackerType("github"), connectionId: "unbound" },
    linearHistory: false,
  },
  poll: { status: "ok" },
  eligible: [],
  claimed: [],
  blocked: [],
  needsHuman: [],
  readyToMerge: [],
  ...over,
  availability: over.availability ?? [],
  contributions: over.contributions ?? [],
});

const status = (over: Partial<DaemonStatus> = {}): DaemonStatus => ({
  health: "running",
  startedAtMillis: 0,
  uptimeMillis: 1000,
  eventBusDroppedEvents: 0,
  scheduler: {
    scheduling: "running",
    globalInFlight: 0,
    globalLimit: 4,
    perWorkspaceLimit: 4,
    dailyBudgetUsed: 0,
    dailyBudgetLimit: 50,
    perWorkspace: [],
  },
  workspaces: [workspace()],
  failures: [],
  ...over,
});

const controlStore: ControlStore = {
  daemonLimits: {
    globalConcurrency: 8,
    perWorkspaceConcurrency: 3,
    dailyBudget: 20,
    revision: 2,
  },
  operationSettings: [],
  connections: [],
  pluginInstalls: [],
  harnessSettings: [],
  contributionSettings: [],
};

describe("formatStatus", () => {
  it("shows daemon event bus loss", () => {
    const output = formatStatus(status({ eventBusDroppedEvents: 17 }));

    assert.include(output, "event bus: 17 dropped events");
  });

  it("stays silent when the daemon event bus has not lost events", () => {
    assert.notInclude(formatStatus(status()), "event bus:");
  });

  it("shows stored rows and labels every daemon-derived section offline", () => {
    const output = formatOfflineStatus(controlStore);

    assert.include(output, "daemon: needs a daemon");
    assert.include(output, "global-concurrency: 8");
    assert.include(output, "scheduler: needs a daemon");
    assert.include(output, "workspace state: needs a daemon");
    assert.include(output, "availability: needs a daemon");
    assert.notInclude(output, "readiness:");
    assert.notInclude(output, "effective settings:");
  });

  it("shows the stored rows and full daemon picture online", () => {
    const output = formatStatusWithStore(status(), controlStore);

    assert.include(output, "daemon: running");
    assert.include(output, "global-concurrency: 8");
    assert.notInclude(output, "needs a daemon");
  });

  it("renders a needs-human section with each item's reason and inline triage proposal", () => {
    const output = formatStatus(
      status({
        workspaces: [
          workspace({
            needsHuman: [
              {
                id: workItemId("#3"),
                title: "waiting on details",
                reason: "needs-info",
                proposal: "Which auth provider should this target?",
                url: "https://github.com/acme/repo/issues/3",
              },
              {
                id: workItemId("#9"),
                title: "keeps failing",
                reason: "ready-for-human",
                proposal: null,
                url: "https://github.com/acme/repo/issues/9",
              },
            ],
          }),
        ],
      }),
    );
    assert.include(output, "      needs-human:");
    assert.include(
      output,
      "        · needs-info #3 waiting on details — Which auth provider should this target?",
    );
    assert.include(output, "        · ready-for-human #9 keeps failing");
  });

  it("renders a ready-to-merge section with each pull request", () => {
    const output = formatStatus(
      status({
        workspaces: [
          workspace({
            readyToMerge: [
              {
                id: workItemId("#7"),
                title: "approved change",
                pr: {
                  number: 17,
                  url: "https://github.com/acme/repo/pull/17",
                  checks: "passing",
                  review: "ready",
                  baseDivergence: "none",
                  waitingSinceMillis: 0,
                },
              },
            ],
          }),
        ],
      }),
    );

    assert.include(output, "      ready-to-merge:");
    assert.include(output, "        · #7 approved change (PR #17)");
  });

  it("removes terminal controls and line breaks from ready-to-merge titles", () => {
    const output = formatStatus(
      status({
        workspaces: [
          workspace({
            readyToMerge: [
              {
                id: workItemId("#7"),
                title: "approved\u001b[2J\nchange",
                pr: {
                  number: 17,
                  url: "https://github.com/acme/repo/pull/17",
                  checks: "passing",
                  review: "ready",
                  baseDivergence: "none",
                  waitingSinceMillis: 0,
                },
              },
            ],
          }),
        ],
      }),
    );

    assert.include(output, "        · #7 approved[2J change (PR #17)");
    assert.notInclude(output, "\u001b");
  });

  it("collapses and truncates a long triage proposal preview to one line", () => {
    const proposal = `${"a".repeat(200)}\nsecond line`;
    const output = formatStatus(
      status({
        workspaces: [
          workspace({
            needsHuman: [
              {
                id: workItemId("#3"),
                title: "big proposal",
                reason: "needs-info",
                proposal,
                url: "https://github.com/acme/repo/issues/3",
              },
            ],
          }),
        ],
      }),
    );
    const line = output.split("\n").find((entry) => entry.includes("#3 big proposal")) ?? "";
    assert.isTrue(line.endsWith("…"));
    assert.isBelow(line.length, 160);
    assert.notInclude(line, "second line");
  });

  it("renders a blocked section with each item's open-blocker count", () => {
    const output = formatStatus(
      status({
        workspaces: [
          workspace({
            blocked: [
              { id: workItemId("#4"), title: "waiting on one", openBlockers: 1 },
              { id: workItemId("#5"), title: "waiting on two", openBlockers: 2 },
            ],
          }),
        ],
      }),
    );
    assert.include(output, "      blocked:");
    assert.include(output, "        · #4 waiting on one (1 open blocker)");
    assert.include(output, "        · #5 waiting on two (2 open blockers)");
  });

  it("omits the blocked section when nothing has an open blocker", () => {
    assert.notInclude(formatStatus(status()), "      blocked:");
  });

  it("omits the needs-human section when nothing is waiting on a human", () => {
    const output = formatStatus(status());
    assert.include(output, "  - cogwork [github] /tmp/cogwork");
    assert.notInclude(output, "needs-human");
  });

  it("shows the registration name beside the minted workspace id", () => {
    const name = workspaceId("0198f16a-21d7-7000-8000-000000000001");
    const output = formatStatus(status({ workspaces: [workspace({ name, displayName: "Cogwork" })] }));

    assert.include(output, `  - Cogwork (${name}) [github] /tmp/cogwork`);
  });

  it("renders eligible and claimed sections alongside the workspace header", () => {
    const output = formatStatus(
      status({
        workspaces: [
          workspace({
            eligible: [{ id: workItemId("#1"), title: "implement me", stage: "implement" }],
            claimed: [
              {
                id: workItemId("#2"),
                title: "in flight",
                claim: {
                  by: "cogwork",
                  claimedAtMillis: 10,
                  operation: { workflow: "coding", operation: "implement" },
                  lineage: { root: lineageId("run-1"), parent: null, hop: 0 },
                },
              },
            ],
          }),
        ],
      }),
    );
    assert.include(output, "        · implement #1 implement me");
    assert.include(output, "        · #2 in flight (by cogwork)");
  });

  it("reports a paused poll, scheduler load, and workspace load failures", () => {
    const output = formatStatus(
      status({
        scheduler: {
          scheduling: "paused",
          globalInFlight: 1,
          globalLimit: 4,
          perWorkspaceLimit: 4,
          dailyBudgetUsed: 7,
          dailyBudgetLimit: 50,
          perWorkspace: [{ name: workspaceId("cogwork"), inFlight: 1, limit: 3 }],
        },
        workspaces: [
          workspace({
            poll: { status: "paused", reason: "auth", message: "auth failed", retryAtMillis: null },
          }),
        ],
        failures: [
          {
            name: workspaceId("failed-workspace"),
            displayName: "Broken workspace",
            source: "broken.workspace.ts",
            message: "boom",
          },
        ],
      }),
    );
    assert.include(output, "scheduler: 1/4 in-flight · budget 7/50 · paused (cogwork=1/3)");
    assert.include(output, "      paused: auth (needs attention) — auth failed");
    assert.include(output, "  ! Broken workspace (failed-workspace) · broken.workspace.ts: boom");
  });

  it("renders a rate-limited pause as self-healing with the retry-at instant", () => {
    const output = formatStatus(
      status({
        workspaces: [
          workspace({
            poll: {
              status: "paused",
              reason: "rate-limited",
              message: "Linear rate limit active",
              retryAtMillis: 1_785_800_000_000,
            },
          }),
        ],
      }),
    );
    assert.include(output, "      paused: rate-limited (self-healing, retrying after 2026-08-03T");
    assert.notInclude(output, "needs attention");
  });

  it("says so when no workspaces are registered", () => {
    assert.include(formatStatus(status({ workspaces: [] })), "  (no workspaces registered)");
  });
});
