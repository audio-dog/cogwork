import { WorkflowTemplate } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { registeredActionRowsFor } from "./workflow-action-registry";
import { issueActionRow, liveParameter } from "./workflow-actions-issue";
import type { WorkflowCatalogContribution } from "./workflow-catalog";

const decodeTemplate = Schema.decodeUnknownSync(WorkflowTemplate);

const trackerNames = {
  github: "GitHub",
  linear: "Linear",
} as const;

const triageLabels = {
  github: "needs-triage",
  linear: "state:needs-triage",
} as const;

const roleLabel = (system: "github" | "linear", role: string) =>
  system === "github" ? role : `state:${role}`;

const stalenessSweepTemplate = (system: "github" | "linear") => {
  const tracker = trackerNames[system];
  return decodeTemplate({
    id: `${system}-staleness-sweep`,
    name: `${tracker} staleness sweep`,
    description: "Review parked issues and keep, retire, or refresh each one.",
    document: {
      name: `${tracker} staleness sweep`,
      workspaces: { _tag: "Every" },
      triggers: [
        {
          id: "sweep",
          entry: "schedule.sweep",
          parameters: [
            { id: "hour", value: "9" },
            { id: "minute", value: "0" },
            { id: "zone", value: "UTC" },
            { id: "source", value: "trackers" },
            { id: "state", value: "parked" },
            { id: "idle-days", value: "30" },
          ],
          start: "judge",
        },
      ],
      operations: [
        {
          id: "judge",
          name: "Judge",
          instructionPackage: null,
          instruction:
            "Review why this issue is parked. Keep it, retire it with a short explanation, or refresh it for triage.",
          permissionProfile: "read-only",
          requires: [],
          model: { harness: null, model: null, options: [] },
          forEach: null,
          questions: [
            {
              id: "verdict",
              text: "What should happen to this issue?",
              choices: [
                { id: "keep", name: "Keep" },
                { id: "retire", name: "Retire" },
                { id: "refresh", name: "Refresh" },
              ],
            },
          ],
          transitions: [
            {
              when: [{ question: "verdict", choice: "keep" }],
              actions: [{ entry: "cogwork.stop", parameters: [] }],
              handOff: null,
            },
            {
              when: [{ question: "verdict", choice: "retire" }],
              actions: [
                { entry: "cogwork.wait-for-approval", parameters: [] },
                { entry: `${system}.comment-this-item`, parameters: [] },
                { entry: `${system}.close-this-issue`, parameters: [] },
              ],
              handOff: null,
            },
            {
              when: [{ question: "verdict", choice: "refresh" }],
              actions: [
                {
                  entry: `${system}.add-label`,
                  parameters: [{ id: "label", value: triageLabels[system] }],
                },
              ],
              handOff: null,
            },
          ],
          hints: [
            { field: "approval_request", text: "Summarize the proposed retirement for approval." },
            { field: "comment", text: "Explain briefly why this issue is being retired." },
          ],
        },
      ],
    },
  });
};

const granolaIssueTemplate = (system: "github" | "linear") => {
  const tracker = trackerNames[system];
  return decodeTemplate({
    id: `granola-to-${system}-issue`,
    name: `Granola → ${tracker} Issue`,
    description: `Turn commitments from a completed Granola note into ${tracker} issues or comments.`,
    document: {
      name: `Granola → ${tracker} Issue`,
      workspaces: { _tag: "Every" },
      triggers: [
        {
          id: "note-generated",
          entry: "granola.note-generated",
          parameters: [],
          start: "extract",
        },
      ],
      operations: [
        {
          id: "extract",
          name: "Extract",
          instructionPackage: null,
          instruction:
            "Extract every concrete commitment from the note. For each commitment, find related issues and decide whether it is new, duplicate, or related.",
          permissionProfile: "read-only",
          requires: [],
          model: { harness: null, model: null, options: [] },
          forEach: "commitment",
          questions: [
            {
              id: "match",
              text: "How does this commitment relate to an existing issue?",
              choices: [
                { id: "new", name: "New" },
                { id: "duplicate", name: "Duplicate" },
                { id: "related", name: "Related" },
              ],
            },
          ],
          transitions: [
            {
              when: [{ question: "match", choice: "new" }],
              actions: [
                {
                  entry: `${system}.create-issue`,
                  parameters: [{ id: "label", value: triageLabels[system] }],
                },
              ],
              handOff: null,
            },
            {
              when: [{ question: "match", choice: "duplicate" }],
              actions: [{ entry: `${system}.comment-issue`, parameters: [] }],
              handOff: null,
            },
            {
              when: [{ question: "match", choice: "related" }],
              actions: [{ entry: `${system}.comment-issue`, parameters: [] }],
              handOff: null,
            },
          ],
          hints: [],
        },
      ],
    },
  });
};

const codingPipelineTemplate = (system: "github" | "linear") => {
  const tracker = trackerNames[system];
  const issueTrigger = `${system}.issue-has-label`;
  const issueCommentTrigger = `${system}.new-comment-from-person`;
  const trackerAction = (id: string) => `${system}.${id}`;
  const labelAction = (role: string) => ({
    entry: trackerAction("add-label"),
    parameters: [{ id: "label", value: roleLabel(system, role) }],
  });
  const commentAction = { entry: trackerAction("comment-this-item"), parameters: [] };
  const removeTriageLabel = {
    entry: trackerAction("remove-label"),
    parameters: [{ id: "label", value: roleLabel(system, "needs-triage") }],
  };
  const triageTransition = (
    role: string,
    trailingActions: ReadonlyArray<{ readonly entry: string; readonly parameters: ReadonlyArray<never> }>,
  ) => ({
    when: [{ question: "role", choice: role }],
    actions: [commentAction, labelAction(role), removeTriageLabel, ...trailingActions],
    handOff: null,
  });
  const handToMe = { entry: "cogwork.hand-to-me", parameters: [] };
  return decodeTemplate({
    id: `${system}-coding-pipeline`,
    name: `${tracker} coding pipeline`,
    description: `Triage ${tracker} issues, implement ready work, and follow up on pull requests.`,
    document: {
      name: `${tracker} coding pipeline`,
      workspaces: { _tag: "Every" },
      triggers: [
        {
          id: "needs-triage",
          entry: issueTrigger,
          parameters: [{ id: "label", value: roleLabel(system, "needs-triage") }],
          start: "triage",
        },
        {
          id: "ready-for-agent",
          entry: issueTrigger,
          parameters: [{ id: "label", value: roleLabel(system, "ready-for-agent") }],
          filters: [{ entry: `${system}.issue-not-blocked` }],
          start: "implement",
        },
        {
          id: "needs-info-comment",
          entry: issueCommentTrigger,
          parameters: [{ id: "label", value: roleLabel(system, "needs-info") }],
          start: "triage",
        },
        {
          id: "checks-failed",
          entry: "github.pull-request-checks-failed",
          parameters: [],
          start: "follow-up",
        },
        {
          id: "base-conflict",
          entry: "github.pull-request-conflicts-with-base",
          parameters: [],
          start: "follow-up",
        },
        {
          id: "review-comment",
          entry: "github.new-review-comment-from-person",
          parameters: [],
          start: "follow-up",
        },
        {
          id: "bot-finding",
          entry: "github.new-finding-from-bot",
          parameters: [{ id: "bot", value: "cursor[bot]" }],
          start: "follow-up",
        },
      ],
      operations: [
        {
          id: "triage",
          name: "Triage",
          instructionPackage: "triage-agent",
          instruction: "",
          permissionProfile: "read-only",
          requires: [],
          model: { harness: null, model: null, options: [] },
          forEach: null,
          questions: [
            {
              id: "role",
              text: "What should happen next?",
              choices: [
                { id: "ready-for-agent", name: "Ready for agent" },
                { id: "needs-info", name: "Needs info" },
                { id: "ready-for-human", name: "Ready for human" },
                { id: "wontfix", name: "Won't fix" },
              ],
            },
          ],
          transitions: [
            triageTransition("ready-for-agent", []),
            triageTransition("needs-info", [handToMe]),
            triageTransition("ready-for-human", [handToMe]),
            triageTransition("wontfix", [{ entry: trackerAction("close-this-issue"), parameters: [] }]),
          ],
          hints: [],
        },
        {
          id: "implement",
          name: "Implement",
          instructionPackage: "implement-agent",
          instruction: "",
          permissionProfile: "full",
          requires: [],
          model: { harness: null, model: null, options: [] },
          forEach: null,
          questions: [],
          transitions: [
            {
              when: [],
              actions: [{ entry: "github.open-pull-request", parameters: [] }],
              handOff: null,
            },
          ],
          hints: [],
        },
        {
          id: "follow-up",
          name: "Follow-up",
          instructionPackage: "follow-up-agent",
          instruction: "",
          permissionProfile: "full",
          requires: [],
          model: { harness: null, model: null, options: [] },
          forEach: null,
          questions: [
            {
              id: "reply",
              text: "Should this follow-up add a comment?",
              choices: [
                { id: "yes", name: "Yes" },
                { id: "no", name: "No" },
              ],
            },
          ],
          transitions: [
            {
              when: [],
              actions: [{ entry: "github.push-to-this-pull-request", parameters: [] }],
              handOff: null,
            },
            {
              when: [{ question: "reply", choice: "yes" }],
              actions: [{ entry: "github.comment-on-this-pull-request", parameters: [] }],
              handOff: null,
            },
          ],
          hints: [],
        },
      ],
    },
  });
};

export const issueTrackerWorkflowCatalogContribution = (system: "github" | "linear") =>
  ({
    entries: [
      issueActionRow(
        system,
        "create-issue",
        "Create an issue",
        ["issue_title", "issue_body"],
        [liveParameter("label", false)],
      ),
      issueActionRow(system, "comment-issue", "Comment on an existing issue", ["issue", "comment"]),
      ...registeredActionRowsFor(system),
    ],
    templates: [granolaIssueTemplate(system), stalenessSweepTemplate(system), codingPipelineTemplate(system)],
  }) satisfies WorkflowCatalogContribution;
