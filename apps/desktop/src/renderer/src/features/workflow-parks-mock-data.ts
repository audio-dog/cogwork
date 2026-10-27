import type { CatalogIcon } from "./workflow-catalog";
import {
  type AgentInputText,
  type AnswerChoice,
  commandsFor,
  type NotificationRecord,
  type ParkedItem,
  type PlanStep,
  type SkippedRecord,
  type WorkflowRef,
} from "./workflow-parks";

const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000;

const workflows = {
  triage: { id: "triage-implement-follow-up", name: "Triage → Implement → Follow-up", revision: 7 },
  granola: { id: "granola-issue", name: "Granola → Issue", revision: 4 },
  slack: { id: "slack-review", name: "Slack → Review", revision: 3 },
  verify: { id: "pr-merged-verify", name: "PR merged → Verify", revision: 2 },
  digest: { id: "monday-digest", name: "Monday digest", revision: 1 },
} satisfies Record<string, WorkflowRef>;

const step = (
  fields: Pick<PlanStep, "id" | "app" | "action" | "target"> &
    Partial<Omit<PlanStep, "id" | "app" | "action" | "target">>,
): PlanStep => ({ inputs: [], parameters: [], state: "planned", note: null, ...fields });

const input = (id: string, label: string, text: string): AgentInputText => ({ id, label, text });

const source = (app: CatalogIcon, label: string) => ({ app, label });
const root = (app: CatalogIcon, label: string) => ({ app, label, workflow: null });
const operationHop = (workflow: WorkflowRef, label: string) => ({
  app: "operation" as const,
  label,
  workflow: workflow.name,
});
const artifact = (app: CatalogIcon, label: string) => ({ app, label, workflow: null });

const parked = (item: Omit<ParkedItem, "commands">): ParkedItem => ({
  ...item,
  commands: commandsFor(item.reason),
});

const triageQuestion = "Is this ticket ready, and who should pick it up?";
const triageChoices: readonly AnswerChoice[] = [
  { id: "ready-for-agent", label: "Ready for agent", input: null },
  { id: "needs-info", label: "Needs info", input: { id: "comment", label: "Question for the reporter" } },
  { id: "ready-for-human", label: "Ready for human", input: null },
  { id: "wontfix", label: "Won't fix", input: null },
];

export const mockParkedItems: readonly ParkedItem[] = [
  parked({
    id: "run:granola-weekly-sync-2",
    title: "Add CSV export to the run ledger",
    source: source("granola", "Weekly product sync"),
    workflow: workflows.granola,
    operation: "Extract",
    lineage: [root("granola", "Weekly product sync")],
    summary:
      "Sam asked for a CSV export of the run ledger so finance can see agent spend per week. Taylor said it should go in this cycle.",
    changedSinceParked: false,
    parkedAtMillis: minutesAgo(6),
    reason: { tag: "awaiting-approval", builtOn: "note revision 14:02" },
    plan: [
      step({
        id: "create",
        app: "github",
        action: "Create an issue",
        target: "cogwork",
        parameters: ["needs-triage"],
        inputs: [
          input("issue_title", "Title", "Add CSV export to the run ledger"),
          input(
            "issue_body",
            "Body",
            "Finance wants agent spend per week. Add a CSV export of the run ledger with one row per Run: Workflow, Operation, Harness, model, tokens, and cost.\n\nAsked for by Sam in the weekly product sync.",
          ),
        ],
      }),
      step({
        id: "linear",
        app: "linear",
        action: "Create an issue",
        target: "cogwork",
        state: "skipped",
        note: "cogwork does not bind Linear",
      }),
      step({
        id: "post",
        app: "slack",
        action: "Send a message",
        target: "#product",
        inputs: [
          input("message", "Message", "Filed the CSV export from today's sync. It goes to triage next."),
        ],
      }),
    ],
  }),
  parked({
    id: "run:slack-review-771",
    title: "Can someone review #771 before the release?",
    source: source("slack", "#eng"),
    workflow: workflows.slack,
    operation: "Review the pull request",
    lineage: [root("slack", "Message in #eng"), operationHop(workflows.slack, "Classify the ask")],
    summary:
      "The change is small and correct. One test asserts on wall-clock time and will be flaky on CI; I suggest TestClock.",
    changedSinceParked: false,
    parkedAtMillis: minutesAgo(14),
    reason: { tag: "awaiting-approval", builtOn: "thread revision 13:51" },
    plan: [
      step({
        id: "comment",
        app: "github",
        action: "Comment on this pull request",
        target: "#771",
        inputs: [
          input(
            "comment",
            "Comment",
            "Looks correct. `scheduler.test.ts` asserts on `Date.now()`, which will flake on CI. Use `TestClock` and advance it in the test.",
          ),
        ],
      }),
      step({
        id: "reply",
        app: "slack",
        action: "Reply as me",
        target: "#eng thread",
        inputs: [
          input("message", "Message", "Reviewed #771: good to go after one test fix. Comment is on the PR."),
        ],
      }),
    ],
  }),
  parked({
    id: "run:triage-805",
    title: "Crash on start when the socket file is stale",
    source: source("github", "#805"),
    workflow: workflows.triage,
    operation: "Triage",
    lineage: [root("github", "#805")],
    summary: "I could not reproduce it. The report has no macOS version and no daemon log.",
    changedSinceParked: false,
    parkedAtMillis: minutesAgo(20),
    reason: { tag: "handed-to-you", question: triageQuestion, choices: triageChoices },
    plan: [],
  }),
  parked({
    id: "run:implement-812",
    title: "Add CSV export to the run ledger",
    source: source("github", "#812"),
    workflow: workflows.triage,
    operation: "Implement",
    lineage: [
      root("granola", "Weekly product sync"),
      operationHop(workflows.granola, "Extract"),
      artifact("github", "#812"),
      operationHop(workflows.triage, "Triage"),
    ],
    summary: "The ledger has no stable column order, so I cannot tell which columns the export must keep.",
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
    source: source("granola", "1:1 Taylor / Sam"),
    workflow: workflows.granola,
    operation: "Extract",
    lineage: [root("granola", "1:1 Taylor / Sam")],
    summary: "Taylor agreed to move staging to Postgres 17 before the schema split. No repository was named.",
    changedSinceParked: false,
    parkedAtMillis: minutesAgo(65),
    reason: { tag: "no-workspace-recognized" },
    plan: [
      step({
        id: "create",
        app: "github",
        action: "Create an issue",
        target: "No Workspace",
        parameters: ["needs-triage"],
        inputs: [
          input("issue_title", "Title", "Move the staging database to Postgres 17"),
          input("issue_body", "Body", "Do this before the users table split."),
        ],
      }),
    ],
  }),
  parked({
    id: "run:granola-feldspar-ops",
    title: "Rotate the Feldspar deploy keys",
    source: source("granola", "Feldspar ops review"),
    workflow: workflows.granola,
    operation: "Extract",
    lineage: [root("granola", "Feldspar ops review")],
    summary: "The team agreed to rotate the deploy keys before the audit on Friday.",
    changedSinceParked: false,
    parkedAtMillis: minutesAgo(88),
    reason: { tag: "write-failed", step: "Add a label", error: "Linear 403: no access to team FEL" },
    plan: [
      step({
        id: "create",
        app: "linear",
        action: "Create an issue",
        target: "feldspar",
        inputs: [input("issue_title", "Title", "Rotate the Feldspar deploy keys")],
        state: "done",
        note: "FEL-212",
      }),
      step({
        id: "label",
        app: "linear",
        action: "Add a label",
        target: "FEL-212",
        parameters: ["security"],
        state: "failed",
        note: "Linear 403: no access to team FEL",
      }),
      step({ id: "notify", app: "cogwork", action: "Notify me", target: "" }),
    ],
  }),
  parked({
    id: "run:support-token",
    title: "How do I rotate the GitHub token?",
    source: source("slack", "#support"),
    workflow: workflows.slack,
    operation: "Classify the ask",
    lineage: [root("slack", "Message in #support")],
    summary: "This is a question I can answer from the docs.",
    changedSinceParked: false,
    parkedAtMillis: minutesAgo(130),
    reason: { tag: "missing-operation", operation: "Answer the question" },
    plan: [],
  }),
  parked({
    id: "run:verify-640",
    title: "Verify: fix the flaky ledger test",
    source: source("github", "#836"),
    workflow: workflows.verify,
    operation: "Verify",
    lineage: [
      root("github", "#640"),
      operationHop(workflows.triage, "Implement"),
      artifact("github", "PR #702"),
      operationHop(workflows.verify, "Verify"),
      artifact("github", "#771"),
      operationHop(workflows.triage, "Implement"),
      artifact("github", "PR #829"),
    ],
    summary: "The merged change still leaves one flaky assertion.",
    changedSinceParked: false,
    parkedAtMillis: minutesAgo(190),
    reason: { tag: "hop-cap", hops: 8 },
    plan: [],
  }),
  parked({
    id: "run:follow-up-798",
    title: "Show plan digest on approvals",
    source: source("github", "#798"),
    workflow: workflows.triage,
    operation: "Follow-up",
    lineage: [
      root("github", "#798"),
      operationHop(workflows.triage, "Implement"),
      artifact("github", "PR #801"),
    ],
    summary: "Three review comments are addressed; the fourth needs the harness.",
    changedSinceParked: true,
    parkedAtMillis: minutesAgo(260),
    reason: { tag: "exhausted", failure: "Harness exited: context window exceeded", attempts: 3 },
    plan: [],
  }),
  parked({
    id: "run:triage-aud-14",
    title: "Rotate the signing keys",
    source: source("linear", "AUD-14"),
    workflow: workflows.triage,
    operation: "Triage",
    lineage: [root("linear", "AUD-14")],
    summary: "This needs admin access to the Apple developer account.",
    changedSinceParked: false,
    parkedAtMillis: minutesAgo(410),
    reason: { tag: "handed-to-you", question: triageQuestion, choices: triageChoices },
    plan: [],
  }),
];

export const mockNotifications: readonly NotificationRecord[] = [
  {
    id: "note:granola-related-823",
    title: "Keep run ledgers for 90 days",
    source: source("granola", "Weekly product sync"),
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
    source: source("github", "PR #779"),
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
    source: source("linear", "AUD-14"),
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

export const mockSkippedRecords: readonly SkippedRecord[] = [
  {
    id: "skip:linear-create",
    workflow: workflows.granola,
    kind: "step",
    app: "linear",
    what: "Create an issue · Weekly product sync",
    reason: "cogwork does not bind Linear",
    atMillis: minutesAgo(6),
  },
  {
    id: "skip:standup",
    workflow: workflows.granola,
    kind: "event",
    app: "granola",
    what: "Note: Standup Oct 12",
    reason: "Older than the 7-day catch-up window",
    atMillis: minutesAgo(50),
  },
  {
    id: "skip:eng-quiet",
    workflow: workflows.slack,
    kind: "event",
    app: "slack",
    what: "Message in #eng",
    reason: "Quiet for 10 min: the thread is still active",
    atMillis: minutesAgo(3),
  },
  {
    id: "skip:eng-own-post",
    workflow: workflows.slack,
    kind: "event",
    app: "slack",
    what: "Reply in #eng by Cogwork",
    reason: "Cogwork posted it",
    atMillis: minutesAgo(12),
  },
  {
    id: "skip:request-review",
    workflow: workflows.triage,
    kind: "step",
    app: "github",
    what: "Request a review · AUD-14",
    reason: "colony-site does not bind GitHub",
    atMillis: minutesAgo(410),
  },
  {
    id: "skip:digest-off",
    workflow: workflows.digest,
    kind: "event",
    app: "schedule",
    what: "Monday 09:00",
    reason: "Workflow is off",
    atMillis: minutesAgo(1900),
  },
];
