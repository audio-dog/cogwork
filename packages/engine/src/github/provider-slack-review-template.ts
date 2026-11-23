import { WorkflowTemplate } from "@cogwork/contracts";
import * as Schema from "effect/Schema";

const decodeTemplate = Schema.decodeUnknownSync(WorkflowTemplate);

export const slackReviewTemplate = decodeTemplate({
  id: "slack-to-github-review",
  name: "Slack → Review",
  description: "Review a GitHub pull request when someone asks in Slack.",
  document: {
    name: "Slack → Review",
    workspaces: { _tag: "Every" },
    triggers: [
      {
        id: "slack-mention",
        entry: "slack.i-am-mentioned",
        parameters: [],
        start: "classify",
      },
    ],
    operations: [
      {
        id: "classify",
        name: "Classify",
        instructionPackage: null,
        instruction:
          "Decide whether the Slack message asks for a pull request review, asks a question, or needs no action.",
        permissionProfile: "read-only",
        commands: { allow: [], deny: [] },
        connections: [],
        requires: [],
        model: { harness: null, model: null, options: [] },
        forEach: null,
        questions: [
          {
            id: "ask",
            text: "What does the Slack message ask for?",
            choices: [
              { id: "review-request", name: "Review request" },
              { id: "question", name: "Question" },
              { id: "not-actionable", name: "Not actionable" },
            ],
          },
        ],
        transitions: [
          {
            when: [{ question: "ask", choice: "review-request" }],
            actions: [
              { entry: "slack.add-reaction", parameters: [{ id: "emoji", value: "eyes" }] },
              { entry: "slack.reply-in-thread", parameters: [] },
            ],
            handOff: "review",
          },
          {
            when: [{ question: "ask", choice: "question" }],
            actions: [{ entry: "slack.draft-reply-in-slack", parameters: [] }],
            handOff: null,
          },
          {
            when: [{ question: "ask", choice: "not-actionable" }],
            actions: [{ entry: "cogwork.stop", parameters: [] }],
            handOff: null,
          },
        ],
        hints: [{ field: "reply", text: "Say that you are reviewing the pull request." }],
      },
      {
        id: "review",
        name: "Review",
        instructionPackage: null,
        instruction:
          "Read the pull request named in the Slack thread. Review the frozen commit and choose a verdict.",
        permissionProfile: "read-only",
        commands: { allow: [], deny: [] },
        connections: [],
        requires: [],
        model: { harness: null, model: null, options: [] },
        forEach: null,
        questions: [
          {
            id: "verdict",
            text: "What is the review verdict?",
            choices: [
              { id: "approve", name: "Approve" },
              { id: "comment", name: "Comment" },
              { id: "request-changes", name: "Request changes" },
              { id: "cannot-review", name: "Cannot review" },
            ],
          },
        ],
        transitions: [
          {
            when: [{ question: "verdict", choice: "approve" }],
            actions: [
              { entry: "github.post-review", parameters: [{ id: "event", value: "approve" }] },
              { entry: "cogwork.wait-for-approval", parameters: [] },
              { entry: "slack.reply-in-thread", parameters: [] },
            ],
            handOff: null,
          },
          {
            when: [{ question: "verdict", choice: "comment" }],
            actions: [
              { entry: "github.post-review", parameters: [{ id: "event", value: "comment" }] },
              { entry: "slack.reply-in-thread", parameters: [] },
            ],
            handOff: null,
          },
          {
            when: [{ question: "verdict", choice: "request-changes" }],
            actions: [
              {
                entry: "github.post-review",
                parameters: [{ id: "event", value: "request-changes" }],
              },
              { entry: "cogwork.wait-for-approval", parameters: [] },
              { entry: "slack.reply-in-thread", parameters: [] },
            ],
            handOff: null,
          },
          {
            when: [{ question: "verdict", choice: "cannot-review" }],
            actions: [{ entry: "cogwork.hand-to-me", parameters: [] }],
            handOff: null,
          },
        ],
        hints: [
          { field: "pull_request", text: "Name the pull request from the Slack thread." },
          { field: "reply", text: "Say that you reviewed the pull request." },
        ],
      },
    ],
  },
});
