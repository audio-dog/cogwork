import type { CatalogIcon } from "./workflow-catalog";

/**
 * PROTOTYPE — issue #794. Mock read-model data for Workflow parks, approvals, notifications, and
 * skipped work. Nothing here comes from the daemon.
 */

export type ParkReason =
  | { readonly tag: "needs-info" }
  | { readonly tag: "ready-for-human" }
  | { readonly tag: "stuck"; readonly summary: string }
  | { readonly tag: "exhausted"; readonly failure: string; readonly attempts: number }
  | { readonly tag: "hop-cap"; readonly hops: number }
  | { readonly tag: "missing-operation"; readonly operation: string }
  | { readonly tag: "write-failed"; readonly step: string; readonly error: string }
  | { readonly tag: "no-workspace-recognized" }
  | { readonly tag: "awaiting-approval"; readonly builtOn: string };

export type ParkTag = ParkReason["tag"];

export type Command = "approve" | "reject" | "hand-back" | "open";

export type StepState = "planned" | "done" | "failed" | "skipped";

export interface AgentInputText {
  readonly id: string;
  readonly label: string;
  readonly text: string;
}

export interface PlanStep {
  readonly id: string;
  readonly app: CatalogIcon;
  readonly action: string;
  readonly target: string;
  readonly parameters: readonly string[];
  readonly inputs: readonly AgentInputText[];
  readonly state: StepState;
  readonly note: string | null;
}

export interface LineageHop {
  readonly kind: "source" | "operation" | "artifact";
  readonly app: CatalogIcon;
  readonly label: string;
  readonly workflow: string | null;
}

export interface Answer {
  readonly question: string;
  readonly choice: string;
}

export interface WorkflowRef {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
}

export interface ParkedItem {
  readonly id: string;
  readonly title: string;
  readonly ref: string;
  readonly source: CatalogIcon;
  readonly workspace: string | null;
  readonly workflow: WorkflowRef;
  readonly operation: string;
  readonly lineage: readonly LineageHop[];
  readonly summary: string;
  readonly answers: readonly Answer[];
  readonly changedSinceParked: boolean;
  readonly parkedAtMillis: number;
  readonly reason: ParkReason;
  readonly plan: readonly PlanStep[];
  readonly commands: readonly Command[];
}

export interface Artifact {
  readonly app: CatalogIcon;
  readonly label: string;
  readonly url: string;
}

export interface NotificationRecord {
  readonly id: string;
  readonly title: string;
  readonly ref: string;
  readonly source: CatalogIcon;
  readonly workflow: WorkflowRef;
  readonly operation: string;
  readonly summary: string;
  readonly answers: readonly Answer[];
  readonly artifacts: readonly Artifact[];
  readonly atMillis: number;
}

export interface SkippedRecord {
  readonly id: string;
  readonly workflowId: string;
  readonly kind: "step" | "event";
  readonly app: CatalogIcon;
  readonly what: string;
  readonly reason: string;
  readonly atMillis: number;
}

const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000;

export const workflows = {
  triage: { id: "triage-implement-follow-up", name: "Triage → Implement → Follow-up", revision: 7 },
  granola: { id: "granola-issue", name: "Granola → Issue", revision: 4 },
  slack: { id: "slack-review", name: "Slack → Review", revision: 3 },
  verify: { id: "pr-merged-verify", name: "PR merged → Verify", revision: 2 },
  digest: { id: "monday-digest", name: "Monday digest", revision: 1 },
} satisfies Record<string, WorkflowRef>;

export const workflowList: readonly WorkflowRef[] = Object.values(workflows);

export const commandsFor = (reason: ParkReason): readonly Command[] => {
  if (reason.tag === "awaiting-approval") return ["approve", "reject", "hand-back"];
  if (reason.tag === "needs-info" || reason.tag === "ready-for-human") return ["open"];
  return ["hand-back"];
};

/** The prototype's answer to "which parks raise an OS notification": the ones only this person can clear. */
export const raisesOsNotification = (reason: ParkReason) =>
  reason.tag !== "needs-info" && reason.tag !== "ready-for-human";

const step = (
  id: string,
  app: CatalogIcon,
  action: string,
  target: string,
  inputs: readonly AgentInputText[] = [],
  parameters: readonly string[] = [],
  state: StepState = "planned",
  note: string | null = null,
) => ({ id, app, action, target, inputs, parameters, state, note });

const input = (id: string, label: string, text: string) => ({ id, label, text });

const source = (app: CatalogIcon, label: string) => ({ kind: "source" as const, app, label, workflow: null });
const operationHop = (workflow: WorkflowRef, label: string) => ({
  kind: "operation" as const,
  app: "operation" as const,
  label,
  workflow: workflow.name,
});
const artifact = (app: CatalogIcon, label: string) => ({
  kind: "artifact" as const,
  app,
  label,
  workflow: null,
});

const parked = (item: Omit<ParkedItem, "commands">): ParkedItem => ({
  ...item,
  commands: commandsFor(item.reason),
});

export const parkedItems: readonly ParkedItem[] = [
  parked({
    id: "run:granola-weekly-sync-2",
    title: "Add CSV export to the run ledger",
    ref: "Weekly product sync",
    source: "granola",
    workspace: "cogwork",
    workflow: workflows.granola,
    operation: "Extract",
    lineage: [source("granola", "Weekly product sync")],
    summary:
      "Sam asked for a CSV export of the run ledger so finance can see agent spend per week. Taylor said it should go in this cycle.",
    answers: [
      { question: "request", choice: "yes" },
      { question: "match", choice: "new" },
    ],
    changedSinceParked: false,
    parkedAtMillis: minutesAgo(6),
    reason: { tag: "awaiting-approval", builtOn: "note revision 14:02" },
    plan: [
      step(
        "create",
        "github",
        "Create an issue",
        "cogwork",
        [
          input("issue_title", "Title", "Add CSV export to the run ledger"),
          input(
            "issue_body",
            "Body",
            "Finance wants agent spend per week. Add a CSV export of the run ledger with one row per Run: Workflow, Operation, Harness, model, tokens, and cost.\n\nAsked for by Sam in the weekly product sync.",
          ),
        ],
        ["needs-triage"],
      ),
      step(
        "linear",
        "linear",
        "Create an issue",
        "cogwork",
        [],
        [],
        "skipped",
        "cogwork does not bind Linear",
      ),
      step("post", "slack", "Send a message", "#product", [
        input("message", "Message", "Filed the CSV export from today's sync. It goes to triage next."),
      ]),
    ],
  }),
  parked({
    id: "run:slack-review-771",
    title: "Can someone review #771 before the release?",
    ref: "#eng",
    source: "slack",
    workspace: "cogwork",
    workflow: workflows.slack,
    operation: "Review the pull request",
    lineage: [source("slack", "Message in #eng"), operationHop(workflows.slack, "Classify the ask")],
    summary:
      "The change is small and correct. One test asserts on wall-clock time and will be flaky on CI; I suggest TestClock.",
    answers: [{ question: "result", choice: "reviewed" }],
    changedSinceParked: false,
    parkedAtMillis: minutesAgo(14),
    reason: { tag: "awaiting-approval", builtOn: "thread revision 13:51" },
    plan: [
      step("comment", "github", "Comment on this pull request", "#771", [
        input(
          "comment",
          "Comment",
          "Looks correct. `scheduler.test.ts` asserts on `Date.now()`, which will flake on CI. Use `TestClock` and advance it in the test.",
        ),
      ]),
      step("reply", "slack", "Reply as me", "#eng thread", [
        input("message", "Message", "Reviewed #771: good to go after one test fix. Comment is on the PR."),
      ]),
    ],
  }),
  parked({
    id: "run:implement-812",
    title: "Add CSV export to the run ledger",
    ref: "#812",
    source: "github",
    workspace: "cogwork",
    workflow: workflows.triage,
    operation: "Implement",
    lineage: [
      source("granola", "Weekly product sync"),
      operationHop(workflows.granola, "Extract"),
      artifact("github", "#812"),
      operationHop(workflows.triage, "Triage"),
    ],
    summary: "The ledger has no stable column order, so I cannot tell which columns the export must keep.",
    answers: [{ question: "outcome", choice: "stuck" }],
    changedSinceParked: true,
    parkedAtMillis: minutesAgo(42),
    reason: {
      tag: "stuck",
      summary: "The ledger has no stable column order, so I cannot tell which columns the export must keep.",
    },
    plan: [],
  }),
  parked({
    id: "run:granola-1on1",
    title: "Move the staging database to Postgres 17",
    ref: "1:1 Taylor / Sam",
    source: "granola",
    workspace: null,
    workflow: workflows.granola,
    operation: "Extract",
    lineage: [source("granola", "1:1 Taylor / Sam")],
    summary: "Taylor agreed to move staging to Postgres 17 before the schema split. No repository was named.",
    answers: [
      { question: "request", choice: "yes" },
      { question: "match", choice: "new" },
    ],
    changedSinceParked: false,
    parkedAtMillis: minutesAgo(65),
    reason: { tag: "no-workspace-recognized" },
    plan: [
      step(
        "create",
        "github",
        "Create an issue",
        "No Workspace",
        [
          input("issue_title", "Title", "Move the staging database to Postgres 17"),
          input("issue_body", "Body", "Do this before the users table split."),
        ],
        ["needs-triage"],
      ),
    ],
  }),
  parked({
    id: "run:granola-feldspar-ops",
    title: "Rotate the Feldspar deploy keys",
    ref: "Feldspar ops review",
    source: "granola",
    workspace: "feldspar",
    workflow: workflows.granola,
    operation: "Extract",
    lineage: [source("granola", "Feldspar ops review")],
    summary: "The team agreed to rotate the deploy keys before the audit on Friday.",
    answers: [
      { question: "request", choice: "yes" },
      { question: "match", choice: "new" },
    ],
    changedSinceParked: false,
    parkedAtMillis: minutesAgo(88),
    reason: { tag: "write-failed", step: "Add a label", error: "Linear 403: no access to team FEL" },
    plan: [
      step(
        "create",
        "linear",
        "Create an issue",
        "feldspar",
        [input("issue_title", "Title", "Rotate the Feldspar deploy keys")],
        [],
        "done",
        "FEL-212",
      ),
      step(
        "label",
        "linear",
        "Add a label",
        "FEL-212",
        [],
        ["security"],
        "failed",
        "Linear 403: no access to team FEL",
      ),
      step("notify", "cogwork", "Notify me", ""),
    ],
  }),
  parked({
    id: "run:support-token",
    title: "How do I rotate the GitHub token?",
    ref: "#support",
    source: "slack",
    workspace: "cogwork",
    workflow: workflows.slack,
    operation: "Classify the ask",
    lineage: [source("slack", "Message in #support")],
    summary: "This is a question I can answer from the docs.",
    answers: [{ question: "ask", choice: "question" }],
    changedSinceParked: false,
    parkedAtMillis: minutesAgo(130),
    reason: { tag: "missing-operation", operation: "Answer the question" },
    plan: [],
  }),
  parked({
    id: "run:verify-640",
    title: "Verify: fix the flaky ledger test",
    ref: "#836",
    source: "github",
    workspace: "cogwork",
    workflow: workflows.verify,
    operation: "Verify",
    lineage: [
      source("github", "#640"),
      operationHop(workflows.triage, "Implement"),
      artifact("github", "PR #702"),
      operationHop(workflows.verify, "Verify"),
      artifact("github", "#771"),
      operationHop(workflows.triage, "Implement"),
      artifact("github", "PR #829"),
    ],
    summary: "The merged change still leaves one flaky assertion.",
    answers: [{ question: "result", choice: "outstanding" }],
    changedSinceParked: false,
    parkedAtMillis: minutesAgo(190),
    reason: { tag: "hop-cap", hops: 8 },
    plan: [],
  }),
  parked({
    id: "run:follow-up-798",
    title: "Show plan digest on approvals",
    ref: "#798",
    source: "github",
    workspace: "cogwork",
    workflow: workflows.triage,
    operation: "Follow-up",
    lineage: [
      source("github", "#798"),
      operationHop(workflows.triage, "Implement"),
      artifact("github", "PR #801"),
    ],
    summary: "Three review comments are addressed; the fourth needs the harness.",
    answers: [],
    changedSinceParked: true,
    parkedAtMillis: minutesAgo(260),
    reason: { tag: "exhausted", failure: "Harness exited: context window exceeded", attempts: 3 },
    plan: [],
  }),
  parked({
    id: "run:triage-805",
    title: "Crash on start when the socket file is stale",
    ref: "#805",
    source: "github",
    workspace: "cogwork",
    workflow: workflows.triage,
    operation: "Triage",
    lineage: [source("github", "#805")],
    summary: "I cannot reproduce it. I asked for the macOS version and the daemon log.",
    answers: [{ question: "role", choice: "needs-info" }],
    changedSinceParked: false,
    parkedAtMillis: minutesAgo(320),
    reason: { tag: "needs-info" },
    plan: [],
  }),
  parked({
    id: "run:triage-aud-14",
    title: "Rotate the signing keys",
    ref: "AUD-14",
    source: "linear",
    workspace: "colony-site",
    workflow: workflows.triage,
    operation: "Triage",
    lineage: [source("linear", "AUD-14")],
    summary: "This needs admin access to the Apple developer account.",
    answers: [{ question: "role", choice: "ready-for-human" }],
    changedSinceParked: false,
    parkedAtMillis: minutesAgo(410),
    reason: { tag: "ready-for-human" },
    plan: [],
  }),
];

export const notifications: readonly NotificationRecord[] = [
  {
    id: "note:granola-related-823",
    title: "Keep run ledgers for 90 days",
    ref: "Weekly product sync",
    source: "granola",
    workflow: workflows.granola,
    operation: "Extract",
    summary: "Created #823. It is related to #640, which sets the current retention to 30 days.",
    answers: [
      { question: "request", choice: "yes" },
      { question: "match", choice: "related" },
    ],
    artifacts: [{ app: "github", label: "#823", url: "https://github.com/colonylabs/cogwork/issues/823" }],
    atMillis: minutesAgo(9),
  },
  {
    id: "note:review-779",
    title: "Sign the Electron build in CI",
    ref: "PR #779",
    source: "github",
    workflow: workflows.slack,
    operation: "Review the pull request",
    summary: "This changes the release signing. It needs someone who knows the release pipeline.",
    answers: [{ question: "result", choice: "cannot-review" }],
    artifacts: [],
    atMillis: minutesAgo(35),
  },
  {
    id: "note:triage-aud-14",
    title: "Rotate the signing keys",
    ref: "AUD-14",
    source: "linear",
    workflow: workflows.triage,
    operation: "Triage",
    summary: "Needs admin access to the Apple developer account.",
    answers: [{ question: "role", choice: "ready-for-human" }],
    artifacts: [
      { app: "linear", label: "Comment on AUD-14", url: "https://linear.app/colony/issue/AUD-14" },
      { app: "linear", label: "Label ready-for-human", url: "https://linear.app/colony/issue/AUD-14" },
    ],
    atMillis: minutesAgo(410),
  },
];

export const skippedRecords: readonly SkippedRecord[] = [
  {
    id: "skip:linear-create",
    workflowId: workflows.granola.id,
    kind: "step",
    app: "linear",
    what: "Create an issue · Weekly product sync",
    reason: "cogwork does not bind Linear",
    atMillis: minutesAgo(6),
  },
  {
    id: "skip:standup",
    workflowId: workflows.granola.id,
    kind: "event",
    app: "granola",
    what: "Note: Standup Oct 12",
    reason: "Older than the 7-day catch-up window",
    atMillis: minutesAgo(50),
  },
  {
    id: "skip:eng-quiet",
    workflowId: workflows.slack.id,
    kind: "event",
    app: "slack",
    what: "Message in #eng",
    reason: "Quiet for 10 min: the thread is still active",
    atMillis: minutesAgo(3),
  },
  {
    id: "skip:eng-own-post",
    workflowId: workflows.slack.id,
    kind: "event",
    app: "slack",
    what: "Reply in #eng by Cogwork",
    reason: "Cogwork posted it",
    atMillis: minutesAgo(12),
  },
  {
    id: "skip:request-review",
    workflowId: workflows.triage.id,
    kind: "step",
    app: "github",
    what: "Request a review · AUD-14",
    reason: "colony-site does not bind GitHub",
    atMillis: minutesAgo(410),
  },
  {
    id: "skip:digest-off",
    workflowId: workflows.digest.id,
    kind: "event",
    app: "schedule",
    what: "Monday 09:00",
    reason: "Workflow is off",
    atMillis: minutesAgo(1900),
  },
];

const fnv1a = (text: string) =>
  [...text]
    .reduce((hash, char) => Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619) >>> 0, 2166136261)
    .toString(16)
    .padStart(8, "0")
    .slice(0, 7);

export const editKey = (item: ParkedItem, planStep: PlanStep, agentInput: AgentInputText) =>
  `${item.id}/${planStep.id}/${agentInput.id}`;

export const inputText = (
  edits: Readonly<Record<string, string>>,
  item: ParkedItem,
  planStep: PlanStep,
  agentInput: AgentInputText,
) => edits[editKey(item, planStep, agentInput)] ?? agentInput.text;

export const planDigest = (item: ParkedItem, edits: Readonly<Record<string, string>>) =>
  fnv1a(
    item.plan
      .filter((planStep) => planStep.state !== "skipped")
      .map(
        (planStep) =>
          `${planStep.app}:${planStep.action}:${planStep.target}:${planStep.parameters.join(",")}:${planStep.inputs
            .map((agentInput) => inputText(edits, item, planStep, agentInput))
            .join("|")}`,
      )
      .join("\n"),
  );

export const isEdited = (item: ParkedItem, edits: Readonly<Record<string, string>>) =>
  item.plan.some((planStep) =>
    planStep.inputs.some((agentInput) => inputText(edits, item, planStep, agentInput) !== agentInput.text),
  );

export const lineageRoot = (item: ParkedItem) => item.lineage[0] ?? null;
