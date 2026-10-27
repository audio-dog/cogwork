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
  source: { app: "granola", label: "Weekly product sync" },
  workflow: { id: "granola-issue", name: "Granola → Issue", revision: 4 },
  operation: "Extract",
  lineage: [],
  summary: "",
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

  it("leaves a skipped step's text out of both the digest and the edited check", () => {
    const skipped = { ...createIssue, id: "linear", app: "linear" as const, state: "skipped" as const };
    const withSkipped = { ...approval, plan: [createIssue, skipped] };
    const edits = { [editKey(withSkipped, skipped, title)]: "Text the plan will not run" };

    expect(planDigest(withSkipped, edits)).toBe(planDigest(withSkipped, {}));
    expect(isEdited(withSkipped, edits)).toBe(false);
  });
});
