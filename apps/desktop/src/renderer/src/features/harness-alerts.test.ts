import {
  HarnessName,
  HarnessReadiness,
  HarnessReadinessItem,
  HarnessSignIn,
  HarnessState,
  WorkflowPark,
  WorkflowRecord,
} from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { harnessAlerts } from "./harness-alerts";

const claude = Schema.decodeSync(HarnessName)("claude");
const codex = Schema.decodeSync(HarnessName)("codex");
const decodeWorkflow = Schema.decodeUnknownSync(WorkflowRecord);
const decodePark = Schema.decodeUnknownSync(WorkflowPark);

const operation = (id: string, harness: string | null) => ({
  id,
  name: id,
  instructionPackage: null,
  instruction: "",
  permissionProfile: "read-only",
  commands: { allow: [], deny: [] },
  connections: [],
  requires: [],
  model: { harness, model: null, options: [] },
  forEach: null,
  questions: [],
  transitions: [],
  hints: [],
});

const workflow = (enabled: boolean, harness: string | null) => {
  const document = {
    name: "Triage",
    workspaces: { _tag: "Every" },
    triggers: [],
    operations: [operation("triage", harness)],
  };
  return decodeWorkflow({
    id: "triage",
    principal: "person",
    workingCopy: document,
    workingRevision: 1,
    publishedCopy: document,
    publishedRevision: 1,
    enabled,
    diagnostics: [],
    readiness: [],
  });
};

const readiness = (state: HarnessState, enabled = true) =>
  HarnessReadiness.make({
    checkedAtMillis: 1,
    harnesses: [HarnessReadinessItem.make({ harness: claude, enabled, version: "2.0.0", state })],
  });

const notSignedIn = HarnessState.cases.NotSignedIn.make({
  signIn: HarnessSignIn.make({ command: "claude auth login" }),
});

const park = (reason: { readonly _tag: string }, operation = "triage") =>
  decodePark({
    item: { _tag: "Issue", workspace: "acme", id: "#1" },
    workflow: "triage",
    publishedRevision: 1,
    operation,
    lineage: { root: "issue:acme:%231", parent: null, hop: 0 },
    summary: "Parked",
    changedSinceParked: false,
    commands: ["hand-back"],
    reason,
    attempt: null,
    parkedAtMillis: 1,
    plan: null,
  });

describe("harnessAlerts", () => {
  it("names the Harness and its sign-in command when an enabled Workflow uses it", () => {
    const [alert] = harnessAlerts({
      workflows: [workflow(true, "claude")],
      defaultHarness: null,
      readiness: readiness(notSignedIn),
      parks: [],
      dismissed: {},
    });
    expect(alert).toMatchObject({
      harness: claude,
      title: "Claude Code is not signed in",
      signIn: "claude auth login",
    });
  });

  it("resolves an Operation without a Harness to the default Harness", () => {
    const alerts = harnessAlerts({
      workflows: [workflow(true, null)],
      defaultHarness: claude,
      readiness: readiness(notSignedIn),
      parks: [],
      dismissed: {},
    });
    expect(alerts.map(({ harness }) => harness)).toEqual([claude]);
  });

  it.each([
    ["the Harness is Ready", [workflow(true, "claude")], readiness(HarnessState.cases.Ready.make({}))],
    ["no enabled Workflow uses the Harness", [workflow(false, "claude")], readiness(notSignedIn)],
    ["enabled Workflows use another Harness", [workflow(true, "codex")], readiness(notSignedIn)],
    ["the Harness is disabled", [workflow(true, "claude")], readiness(notSignedIn, false)],
  ])("shows nothing when %s", (_case, workflows, current) => {
    expect(
      harnessAlerts({ workflows, defaultHarness: codex, readiness: current, parks: [], dismissed: {} }),
    ).toEqual([]);
  });

  it("hides a dismissed alert until the Harness state or its message changes", () => {
    const alertsFor = (state: HarnessState, dismissed: Readonly<Record<string, string>>) =>
      harnessAlerts({
        workflows: [workflow(true, "claude")],
        defaultHarness: null,
        readiness: readiness(state),
        parks: [],
        dismissed,
      });
    const [shown] = alertsFor(notSignedIn, {});
    const dismissed = shown ? { [shown.harness]: shown.key } : {};
    const otherCommand = HarnessState.cases.NotSignedIn.make({
      signIn: HarnessSignIn.make({ command: "claude login" }),
    });
    const notInstalled = HarnessState.cases.NotInstalled.make({ diagnostic: "claude not on PATH" });
    expect(alertsFor(notSignedIn, dismissed)).toEqual([]);
    expect(alertsFor(otherCommand, dismissed)).toHaveLength(1);
    expect(alertsFor(notInstalled, dismissed)).toHaveLength(1);
  });

  it("counts the items its Operations parked as MissingOperation", () => {
    const [alert] = harnessAlerts({
      workflows: [workflow(true, "claude")],
      defaultHarness: null,
      readiness: readiness(notSignedIn),
      parks: [
        park({ _tag: "MissingOperation" }),
        park({ _tag: "HopCap" }),
        park({ _tag: "MissingOperation" }, "review"),
      ],
      dismissed: {},
    });
    expect(alert?.parked).toBe(1);
  });
});
