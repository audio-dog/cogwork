import { describe, expect, it } from "vitest";
import { commandsFor, editKey, isEdited, type ParkedItem, planDigest } from "./workflow-parks";

const title = { id: "issue_title", label: "Title", text: "Add CSV export to the run ledger" };
const createIssue = {
  id: "create",
  app: "github" as const,
  action: "Create an issue",
  target: "cogwork",
  parameters: ["needs-triage"],
  inputs: [title],
  state: "planned" as const,
  note: null,
};

const reason = { tag: "awaiting-approval" as const, builtOn: "note revision 14:02" };

const approval: ParkedItem = {
  id: "run:granola-weekly-sync",
  title: "Add CSV export to the run ledger",
  ref: "Weekly product sync",
  source: "granola",
  workspace: "cogwork",
  workflow: { id: "granola-issue", name: "Granola → Issue", revision: 4 },
  operation: "Extract",
  lineage: [],
  summary: "",
  answers: [],
  changedSinceParked: false,
  parkedAtMillis: 0,
  reason,
  plan: [createIssue],
  commands: commandsFor(reason),
};

describe("planDigest", () => {
  it("names a different plan once the person edits agent text", () => {
    const edits = { [editKey(approval, createIssue, title)]: "Export the run ledger as CSV" };

    expect(planDigest(approval, edits)).not.toBe(planDigest(approval, {}));
    expect(isEdited(approval, edits)).toBe(true);
  });

  it("names the frozen plan again when the edit restores the agent's text", () => {
    const edits = { [editKey(approval, createIssue, title)]: title.text };

    expect(planDigest(approval, edits)).toBe(planDigest(approval, {}));
    expect(isEdited(approval, edits)).toBe(false);
  });
});
