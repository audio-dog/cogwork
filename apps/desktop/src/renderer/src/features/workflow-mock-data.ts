import { type CatalogChoice, handOffTo, pickAction, pickTrigger } from "./workflow-catalog";
import type { Condition, Operation, Question, Route, Workflow } from "./workflow-model";

/**
 * Mock Workflows for the Workflows screens. Nothing here reaches the daemon: the engine does not
 * store user-authored Workflows yet, so the list and the editor read these instead.
 */

const question = (key: string, text: string, ...choices: readonly string[]): Question => ({
  id: key,
  key,
  text,
  choices: choices.map((name) => ({ id: name, name })),
});

const route = (when: Condition, ...steps: readonly CatalogChoice[]): Route => ({ when, steps });

const operation = (
  id: string,
  name: string,
  instruction: string,
  questions: readonly Question[],
  routes: readonly Route[],
): Operation => ({
  id,
  name,
  instruction,
  model: { harness: null, model: null },
  questions,
  routes,
  inputs: {},
});

const implement = { id: "implement", name: "Implement" };
const followUp = { id: "follow-up", name: "Follow-up" };
const review = { id: "review", name: "Review the pull request" };

export const mockWorkflows: readonly Workflow[] = [
  {
    id: "triage-implement-follow-up",
    name: "Triage → Implement → Follow-up",
    enabled: true,
    workspaces: ["cogwork", "feldspar", "colony-site"],
    triggers: [pickTrigger("github", "issue-labelled", "needs-triage")],
    operations: [
      operation(
        "triage",
        "Triage",
        "Read the issue and its comments, explore the codebase, and verify the claim where you can. Then decide whether it is clear enough for an agent to finish on its own, needs something only the reporter can answer, needs a human's judgement, or should not be done.",
        [
          question(
            "role",
            "Is this ticket ready, and who should pick it up?",
            "ready-for-agent",
            "needs-info",
            "ready-for-human",
            "wontfix",
          ),
        ],
        [
          route({}, pickAction("github", "comment")),
          route(
            { role: "ready-for-agent" },
            pickAction("github", "label", "ready-for-agent"),
            handOffTo(implement),
          ),
          route({ role: "needs-info" }, pickAction("github", "label", "needs-info")),
          route(
            { role: "ready-for-human" },
            pickAction("github", "label", "ready-for-human"),
            pickAction("cogwork", "notify"),
          ),
          route({ role: "wontfix" }, pickAction("github", "label", "wontfix"), pickAction("github", "close")),
        ],
      ),
      operation(
        "implement",
        "Implement",
        "Read the issue as the brief, make the change, pass the local gate, and commit. Say whether the branch is ready for a pull request, or whether you are stuck.",
        [question("outcome", "Is the change ready for a pull request?", "ready-for-pr", "stuck")],
        [
          route({ outcome: "ready-for-pr" }, pickAction("github", "open-pr"), handOffTo(followUp)),
          route(
            { outcome: "stuck" },
            pickAction("github", "label", "blocked"),
            pickAction("cogwork", "notify"),
          ),
        ],
      ),
      operation(
        "follow-up",
        "Follow-up",
        "Read the failing checks and the new review comments on the pull request. Fix what you can and push to the same branch. Never merge.",
        [question("result", "Did you address every comment and failing check?", "addressed", "needs-human")],
        [
          route({ result: "addressed" }, pickAction("github", "request-review")),
          route({ result: "needs-human" }, pickAction("cogwork", "notify")),
        ],
      ),
    ],
    waiting: 2,
  },
  {
    id: "granola-issue",
    name: "Granola → Issue",
    enabled: true,
    workspaces: ["cogwork"],
    triggers: [pickTrigger("granola", "transcript")],
    operations: [
      operation(
        "extract",
        "Extract",
        "Read the meeting transcript. Find work that someone committed to and that is worth tracking. Search the tracker before you suggest a new issue, and say whether the work already has an issue, has a related one, or is new.",
        [
          question("request", "Did someone commit to work that should be tracked?", "yes", "no"),
          question("match", "Does a matching issue already exist?", "new", "duplicate", "related"),
        ],
        [
          route({ request: "no" }, pickAction("cogwork", "stop")),
          route(
            { request: "yes", match: "new" },
            pickAction("github", "create-issue"),
            pickAction("github", "label", "needs-triage"),
          ),
          route({ request: "yes", match: "duplicate" }, pickAction("github", "comment")),
          route(
            { request: "yes", match: "related" },
            pickAction("github", "create-issue"),
            pickAction("cogwork", "notify"),
          ),
        ],
      ),
    ],
    waiting: 1,
  },
  {
    id: "slack-review",
    name: "Slack → Review",
    enabled: true,
    workspaces: ["cogwork", "feldspar"],
    triggers: [pickTrigger("slack", "directed")],
    operations: [
      operation(
        "classify",
        "Classify the ask",
        "Read the Slack message and the thread around it. Decide whether it asks for a pull request review, asks a question you can answer from the codebase, or needs nothing from you.",
        [question("ask", "What is this message asking for?", "review-request", "question", "not-actionable")],
        [
          route({ ask: "review-request" }, handOffTo(review)),
          route({ ask: "question" }, pickAction("slack", "reply")),
          route({ ask: "not-actionable" }, pickAction("cogwork", "stop")),
        ],
      ),
      operation(
        "review",
        "Review the pull request",
        "Review the pull request the message names. Leave the review as one comment, and say when the change needs a person who knows the area.",
        [question("result", "Could you review the pull request?", "reviewed", "cannot-review")],
        [
          route({ result: "reviewed" }, pickAction("github", "comment"), pickAction("slack", "reply")),
          route({ result: "cannot-review" }, pickAction("cogwork", "notify")),
        ],
      ),
    ],
    waiting: 0,
  },
  {
    id: "staleness-sweep",
    name: "Staleness sweep",
    enabled: true,
    workspaces: ["cogwork", "feldspar", "colony-site"],
    triggers: [pickTrigger("schedule", "daily", "08:00")],
    operations: [
      operation(
        "judge",
        "Judge parked work",
        "Read each parked issue and what has happened since it was parked. Decide whether it is still worth doing, was handled elsewhere, or needs a fresh look.",
        [question("verdict", "Is this parked work still worth doing?", "keep", "retire", "refresh")],
        [
          route({ verdict: "retire" }, pickAction("github", "comment"), pickAction("github", "close")),
          route({ verdict: "refresh" }, pickAction("github", "label", "needs-triage")),
        ],
      ),
    ],
    waiting: 0,
  },
  {
    id: "pr-merged-verify",
    name: "PR merged → Verify",
    enabled: false,
    workspaces: [],
    triggers: [pickTrigger("github", "pull-request", "Merged")],
    operations: [
      operation(
        "verify",
        "Verify",
        "Read the issue the pull request closes and the merged change. Decide whether the change does everything the issue asked for.",
        [
          question(
            "result",
            "Does the merged change fulfil the original request?",
            "fulfilled",
            "outstanding",
          ),
        ],
        [
          route({ result: "fulfilled" }, pickAction("github", "close")),
          route(
            { result: "outstanding" },
            pickAction("github", "create-issue"),
            pickAction("github", "comment"),
          ),
        ],
      ),
    ],
    waiting: 0,
  },
  {
    id: "monday-digest",
    name: "Monday digest",
    enabled: false,
    workspaces: ["cogwork"],
    triggers: [pickTrigger("schedule", "weekly", "Monday")],
    operations: [
      operation(
        "digest",
        "Draft the digest",
        "Gather what merged last week and what is planned for this week. Draft a short digest, and decide whether there is enough to be worth sending.",
        [question("worth", "Is there enough to report this week?", "publish", "withhold")],
        [
          route({ worth: "publish" }, pickAction("slack", "send", "#engineering")),
          route({ worth: "withhold" }, pickAction("cogwork", "stop")),
        ],
      ),
    ],
    waiting: 0,
  },
];

export const mockWorkspaces = ["cogwork", "feldspar", "colony-site"] as const;

export const mockWorkflow = (id: string) => mockWorkflows.find((workflow) => workflow.id === id) ?? null;

export const untitledWorkflow: Workflow = {
  id: "new",
  name: "Untitled Workflow",
  enabled: false,
  workspaces: [],
  triggers: [],
  operations: [],
  waiting: 0,
};
