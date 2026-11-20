// @vitest-environment happy-dom

import {
  type WorkflowAttention,
  WorkflowAttention as WorkflowAttentionSchema,
  WorkflowCatalog as WorkflowCatalogSchema,
  type WorkflowNotification,
  WorkflowNotification as WorkflowNotificationSchema,
  WorkflowRecord as WorkflowRecordSchema,
  WorkflowTouchpointFailure,
} from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Attention } from "../components/attention-board";
import { type AttentionClient, AttentionClientProvider, type AttentionSnapshot } from "./attention-session";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const decodeAttention = Schema.decodeUnknownSync(WorkflowAttentionSchema);
const decodeCatalog = Schema.decodeUnknownSync(WorkflowCatalogSchema);
const decodeNotification = Schema.decodeUnknownSync(WorkflowNotificationSchema);
const decodeWorkflow = Schema.decodeUnknownSync(WorkflowRecordSchema);

const item = { _tag: "Issue", workspace: "acme", id: "#817" } as const;
const lineage = { root: "issue:acme:%23817", parent: null, hop: 0 };
const operation = {
  id: "review",
  name: "Review",
  instructionPackage: null,
  instruction: "",
  permissionProfile: "read-only",
  requires: [],
  model: { harness: null, model: null, options: [] },
  forEach: null,
  questions: [
    {
      id: "decision",
      text: "What should happen?",
      choices: [
        { id: "ready", name: "Ready" },
        { id: "needs-info", name: "Needs info" },
      ],
    },
  ],
  transitions: [
    { when: [{ question: "decision", choice: "ready" }], actions: [], handOff: null },
    {
      when: [{ question: "decision", choice: "needs-info" }],
      actions: [{ entry: "github.comment-this-item", parameters: [] }],
      handOff: null,
    },
  ],
  hints: [
    { field: "comment", text: "Question for the reporter" },
    { field: "label", text: "Label to add" },
  ],
};
const workflow = decodeWorkflow({
  id: "triage",
  principal: "person",
  workingCopy: { name: "Triage", workspaces: { _tag: "Every" }, triggers: [], operations: [operation] },
  workingRevision: 4,
  publishedCopy: {
    name: "Triage",
    workspaces: { _tag: "Every" },
    triggers: [],
    operations: [operation],
  },
  publishedRevision: 4,
  enabled: true,
  diagnostics: [],
  readiness: [],
});
const catalog = decodeCatalog({
  entries: [
    {
      key: "github.comment-this-item",
      name: "Comment on this item",
      kind: "action",
      system: "github",
      connection: "github",
      requires: [],
      parameters: [],
      itemKind: "issue",
      actsOn: ["issue"],
      requiresWorkspace: true,
      workspaceSource: "item-else-agent",
      permissionProfile: "read-only",
      agentInputs: ["comment", "label"],
      emits: [],
    },
    {
      key: "cogwork.wait-for-approval",
      name: "Wait for my approval",
      kind: "action",
      system: null,
      connection: null,
      requires: [],
      parameters: [],
      itemKind: null,
      actsOn: [],
      requiresWorkspace: false,
      workspaceSource: null,
      permissionProfile: "read-only",
      agentInputs: ["approval_request"],
      emits: [],
    },
  ],
  instructionPackages: [],
  harnesses: [],
});

const plan = {
  item: "issue:acme:%23817",
  workflow: "triage",
  attempt: "run-817",
  operation: "review",
  revision: "revision-2",
  createdAtMillis: 20,
  consumedHandbackAtMillis: 0,
  digest: "shown-digest",
  workflowRevision: 4,
  summary: "Ready to comment",
  answers: { decision: "needs-info" },
  inputs: { approval_request: "Run this plan", comment: "Original question" },
  workspace: "acme",
  lineage,
  handOff: null,
  steps: [
    {
      position: 0,
      entry: "cogwork.wait-for-approval",
      parameters: [],
      inputs: { approval_request: "Run this plan" },
      target: { _tag: "Cogwork" },
      writeKey: "approval",
      status: "pending",
      failures: 0,
      artifact: null,
    },
    {
      position: 1,
      entry: "github.comment-this-item",
      parameters: [],
      inputs: { comment: "Original question" },
      target: {
        _tag: "CurrentIssue",
        workspace: "acme",
        app: "github",
        issueTracker: { type: "github", repo: "taylor/cogwork" },
        repository: "taylor/cogwork",
        issue: "#817",
      },
      writeKey: "comment",
      status: "pending",
      failures: 0,
      artifact: null,
    },
  ],
};

const attentionWith = (
  reason: Record<string, unknown>,
  commands: ReadonlyArray<string>,
  activePlan: unknown = plan,
  summary = "Ready to comment",
) =>
  decodeAttention({
    parks: [
      {
        item,
        workflow: "triage",
        publishedRevision: 4,
        operation: "review",
        lineage,
        summary,
        changedSinceParked: false,
        commands,
        reason,
        attempt: "run-817",
        parkedAtMillis: 30,
        plan: activePlan,
      },
    ],
    skipped: [],
  });

const notification = decodeNotification({
  id: "triage:review:revision-2",
  item,
  workflow: "triage",
  operation: "review",
  summary: "Commented on #817",
  answers: { decision: "needs-info" },
  artifacts: [],
  atMillis: 40,
});

const snapshot = (
  attention: WorkflowAttention,
  notifications: ReadonlyArray<WorkflowNotification> = [],
): AttentionSnapshot => ({ attention, notifications, workflows: [workflow], catalog });

const defaultClient = (): AttentionClient => ({
  approve: async () => "approved-digest",
  reject: async () => undefined,
  handBack: async () => undefined,
  chooseAnswer: async () => undefined,
  dismiss: async () => undefined,
});

const renderAttention = async (value: {
  snapshot: AttentionSnapshot;
  client: AttentionClient;
  notificationFailure?: string;
  onOpenNotificationSettings?: () => void;
}) => {
  function Harness() {
    const [focus, setFocus] = useState<string | null>("issue:acme:%23817");
    return (
      <AttentionClientProvider
        snapshot={value.snapshot}
        client={value.client}
        layout="list"
        focus={focus}
        onFocusChange={setFocus}
        onLayoutChange={() => undefined}
        onOpenItem={() => undefined}
        onRefresh={() => undefined}
        notificationFailure={value.notificationFailure ?? null}
        onOpenNotificationSettings={value.onOpenNotificationSettings ?? (() => undefined)}
      >
        <Attention.Frame>
          <Attention.Lanes />
        </Attention.Frame>
      </AttentionClientProvider>
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Harness />);
  });
  return { container, root };
};

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);

const element = (container: ParentNode, label: string) =>
  [...container.querySelectorAll<HTMLElement>("*")].find(
    (candidate) => candidate.children.length === 0 && candidate.textContent?.trim() === label,
  );

const changeTextarea = async (textarea: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("AttentionClientProvider", () => {
  beforeEach(() => document.body.replaceChildren());

  it("shows a named pull request and its line comments", async () => {
    const reviewPlan = {
      ...plan,
      inputs: {
        pull_request: "#826",
        review_body: "Review body",
        review_comments: [{ path: "src/review.ts", line: 12, body: "Check this." }],
      },
      steps: [
        {
          position: 0,
          entry: "github.post-review",
          parameters: [{ id: "event", value: "comment" }],
          inputs: {
            pull_request: "#826",
            review_body: "Review body",
            review_comments: [{ path: "src/review.ts", line: 12, body: "Check this." }],
          },
          target: {
            _tag: "NamedPullRequest",
            workspace: "acme",
            app: "github",
            issueTracker: { type: "github", repo: "taylor/cogwork" },
            repository: "taylor/cogwork",
            number: 826,
            url: "https://github.com/taylor/cogwork/pull/826",
            headBranch: "review-actions",
            baseBranch: "main",
            headSha: "abc123",
          },
          writeKey: "review",
          status: "pending",
          failures: 0,
          artifact: null,
        },
      ],
    };
    const { container, root } = await renderAttention({
      snapshot: snapshot(
        attentionWith(
          { _tag: "AwaitingApproval", plan: "run-817", digest: "shown-digest", revision: "revision-2" },
          ["approve", "reject"],
          reviewPlan,
        ),
      ),
      client: defaultClient(),
    });

    expect(container.textContent).toContain("PR #826");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="More"]')?.click());
    await act(async () => element(document.body, "Edit")?.click());
    expect(
      container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Review Comments"]')?.value,
    ).toBe("src/review.ts:12 — Check this.");
    await act(async () => root.unmount());
  });

  it("sends the shown digest and edited text, and shows a stale refusal", async () => {
    const approve = vi.fn<AttentionClient["approve"]>().mockRejectedValueOnce(
      new WorkflowTouchpointFailure({
        reason: "stale-digest",
        message: "The plan changed after it was displayed",
      }),
    );
    const { container, root } = await renderAttention({
      snapshot: snapshot(
        attentionWith(
          { _tag: "AwaitingApproval", plan: "run-817", digest: "shown-digest", revision: "revision-2" },
          ["approve", "reject", "hand-back"],
        ),
      ),
      client: { ...defaultClient(), approve },
    });

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="More"]')?.click());
    await act(async () => element(document.body, "Edit")?.click());
    const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]');
    expect(input).not.toBeNull();
    if (!input) return;
    await changeTextarea(input, "Edited question");
    await act(async () => button(container, "Approve")?.click());

    expect(approve).toHaveBeenCalledWith({
      item: expect.objectContaining({ _tag: "Issue", id: "#817" }),
      attempt: "run-817",
      digest: "shown-digest",
      edits: { comment: "Edited question" },
    });
    expect(container.textContent).toContain("The plan changed after it was displayed");
    await act(async () => root.unmount());
  });

  it("requires the empty input for a chosen answer before sending it", async () => {
    const chooseAnswer = vi.fn<AttentionClient["chooseAnswer"]>();
    const handedPlan = { ...plan, answers: {}, inputs: { comment: "", label: "" }, steps: [] };
    const { container, root } = await renderAttention({
      snapshot: snapshot(attentionWith({ _tag: "HandedToYou" }, ["choose-answer", "hand-back"], handedPlan)),
      client: { ...defaultClient(), chooseAnswer },
    });

    await act(async () => button(container, "Needs info")?.click());
    const input = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Question for the reporter"]',
    );
    const label = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Label to add"]');
    const confirm = button(container, "Needs info");
    expect(input).not.toBeNull();
    expect(label).not.toBeNull();
    expect(confirm?.disabled).toBe(true);
    if (!input || !label) return;
    await changeTextarea(input, "Which macOS version?");
    expect(confirm?.disabled).toBe(true);
    await changeTextarea(label, "needs-reproduction");
    await act(async () => button(container, "Needs info")?.click());

    expect(chooseAnswer).toHaveBeenCalledWith({
      item: expect.objectContaining({ _tag: "Issue", id: "#817" }),
      attempt: "run-817",
      answers: { decision: "needs-info" },
      inputs: { comment: "Which macOS version?", label: "needs-reproduction" },
    });
    await act(async () => root.unmount());
  });

  it("sends the handback note", async () => {
    const handBack = vi.fn<AttentionClient["handBack"]>();
    const { container, root } = await renderAttention({
      snapshot: snapshot(attentionWith({ _tag: "Stuck", summary: "Need a person" }, ["hand-back"], null)),
      client: { ...defaultClient(), handBack },
    });

    await act(async () => button(container, "Hand back")?.click());
    const note = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note"]');
    expect(note).not.toBeNull();
    if (!note) return;
    await changeTextarea(note, "Use the newer report");
    await act(async () => button(container, "Hand back")?.click());
    expect(handBack).toHaveBeenCalledWith({
      item: expect.objectContaining({ _tag: "Issue", id: "#817" }),
      note: "Use the newer report",
    });
    await act(async () => root.unmount());
  });

  it("shows what to do, the worktree path, and the unmerged files for a blocked worktree", async () => {
    const instruction = "Branch 947 has a merge in progress in its worktree. Finish or abort it.";
    const { container, root } = await renderAttention({
      snapshot: snapshot(
        attentionWith(
          {
            _tag: "WorktreeBlocked",
            reason: "operation-in-progress",
            branch: "947",
            path: "/worktrees/947",
            operation: "merge",
            unmergedPaths: ["src/a.ts", "src/b.ts"],
          },
          ["hand-back"],
          null,
          instruction,
        ),
      ),
      client: defaultClient(),
    });

    const text = container.textContent ?? "";
    expect(text.split(instruction)).toHaveLength(2);
    expect(text).toContain("/worktrees/947");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("src/b.ts");
    await act(async () => root.unmount());
  });

  it("dismisses a notification through the client", async () => {
    const dismiss = vi.fn<AttentionClient["dismiss"]>();
    const { container, root } = await renderAttention({
      snapshot: snapshot(attentionWith({ _tag: "Stuck", summary: "Need a person" }, ["hand-back"], null), [
        notification,
      ]),
      client: { ...defaultClient(), dismiss },
    });

    await act(async () =>
      element(container, "Commented on #817")
        ?.closest<HTMLElement>('[data-slot="collapsible-trigger"]')
        ?.click(),
    );
    await act(async () => button(container, "Dismiss")?.click());

    expect(dismiss).toHaveBeenCalledWith({ id: "triage:review:revision-2" });
    await act(async () => root.unmount());
  });

  it("keeps the Attention list visible and points to System Settings when OS delivery fails", async () => {
    const openSettings = vi.fn();
    const { container, root } = await renderAttention({
      snapshot: snapshot(attentionWith({ _tag: "Stuck", summary: "Need a person" }, ["hand-back"], null)),
      client: defaultClient(),
      notificationFailure: "Notifications are not allowed",
      onOpenNotificationSettings: openSettings,
    });

    expect(container.textContent).toContain("Need a person");
    expect(container.textContent).toContain("Parks still appear here");
    await act(async () => button(container, "System Settings")?.click());
    expect(openSettings).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });
});
