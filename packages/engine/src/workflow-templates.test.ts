import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { temporaryStore, withWorkflows } from "./workflow-fixtures";

layer(NodeServices.layer)((it) => {
  it.effect("creates and publishes every shipped Workflow template", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const templates = yield* withWorkflows(storePath, ({ templates }) => templates);

      assert.deepStrictEqual(
        templates
          .filter(({ id }) => !id.endsWith("-coding-pipeline"))
          .map(({ id, document }) => ({
            id: String(id),
            trigger: String(document.triggers[0]?.entry),
            forEach: document.operations[0]?.forEach,
            choices: document.operations[0]?.questions[0]?.choices.map(({ id }) => String(id)),
            actions: document.operations[0]?.transitions.map(({ when, actions }) => ({
              choice: String(when[0]?.choice),
              entry: String(actions[0]?.entry),
              parameters: actions[0]?.parameters.map(({ id, value }) => ({ id: String(id), value })),
            })),
          })),
        [
          {
            id: "granola-to-github-issue",
            trigger: "granola.note-generated",
            forEach: "commitment",
            choices: ["new", "duplicate", "related"],
            actions: [
              {
                choice: "new",
                entry: "github.create-issue",
                parameters: [{ id: "label", value: "needs-triage" }],
              },
              { choice: "duplicate", entry: "github.comment-issue", parameters: [] },
              { choice: "related", entry: "github.comment-issue", parameters: [] },
            ],
          },
          {
            id: "github-staleness-sweep",
            trigger: "schedule.sweep",
            forEach: null,
            choices: ["keep", "retire", "refresh"],
            actions: [
              { choice: "keep", entry: "cogwork.stop", parameters: [] },
              { choice: "retire", entry: "cogwork.wait-for-approval", parameters: [] },
              {
                choice: "refresh",
                entry: "github.add-label",
                parameters: [{ id: "label", value: "needs-triage" }],
              },
            ],
          },
          {
            id: "granola-to-linear-issue",
            trigger: "granola.note-generated",
            forEach: "commitment",
            choices: ["new", "duplicate", "related"],
            actions: [
              {
                choice: "new",
                entry: "linear.create-issue",
                parameters: [{ id: "label", value: "state:needs-triage" }],
              },
              { choice: "duplicate", entry: "linear.comment-issue", parameters: [] },
              { choice: "related", entry: "linear.comment-issue", parameters: [] },
            ],
          },
          {
            id: "linear-staleness-sweep",
            trigger: "schedule.sweep",
            forEach: null,
            choices: ["keep", "retire", "refresh"],
            actions: [
              { choice: "keep", entry: "cogwork.stop", parameters: [] },
              { choice: "retire", entry: "cogwork.wait-for-approval", parameters: [] },
              {
                choice: "refresh",
                entry: "linear.add-label",
                parameters: [{ id: "label", value: "state:needs-triage" }],
              },
            ],
          },
          {
            id: "slack-to-github-review",
            trigger: "slack.i-am-mentioned",
            forEach: null,
            choices: ["review-request", "question", "not-actionable"],
            actions: [
              {
                choice: "review-request",
                entry: "slack.add-reaction",
                parameters: [{ id: "emoji", value: "eyes" }],
              },
              { choice: "question", entry: "slack.draft-reply-in-slack", parameters: [] },
              { choice: "not-actionable", entry: "cogwork.stop", parameters: [] },
            ],
          },
        ],
      );
      assert.deepStrictEqual(
        templates
          .filter(({ id }) => id.endsWith("-coding-pipeline"))
          .map(({ id, document }) => ({
            id: String(id),
            triggers: document.triggers.map(({ entry, parameters, start }) => ({
              entry: String(entry),
              parameters: parameters.map(({ id, value }) => `${id}:${value}`),
              start: String(start),
            })),
            operations: document.operations.map(({ id, instructionPackage, questions, transitions }) => ({
              id: String(id),
              instructionPackage,
              choices: questions.flatMap(({ choices }) => choices.map(({ id: choice }) => String(choice))),
              routes: transitions.map(({ when, actions, handOff }) => ({
                when: when.map(({ question, choice }) => `${question}:${choice}`),
                actions: actions.map(({ entry, parameters }) =>
                  [entry, ...parameters.map(({ id, value }) => `${id}:${value}`)].join(":"),
                ),
                handOff: handOff === null ? null : String(handOff),
              })),
            })),
          })),
        [
          {
            id: "github-coding-pipeline",
            triggers: [
              { entry: "github.issue-has-label", parameters: ["label:needs-triage"], start: "triage" },
              {
                entry: "github.issue-has-label",
                parameters: ["label:ready-for-agent"],
                start: "implement",
              },
              {
                entry: "github.new-comment-from-person",
                parameters: ["label:needs-info"],
                start: "triage",
              },
              { entry: "github.pull-request-checks-failed", parameters: [], start: "follow-up" },
              {
                entry: "github.pull-request-conflicts-with-base",
                parameters: [],
                start: "follow-up",
              },
              {
                entry: "github.new-review-comment-from-person",
                parameters: [],
                start: "follow-up",
              },
              {
                entry: "github.new-finding-from-bot",
                parameters: ["bot:cursor[bot]"],
                start: "follow-up",
              },
            ],
            operations: [
              {
                id: "triage",
                instructionPackage: "triage-agent",
                choices: ["ready-for-agent", "needs-info", "ready-for-human", "wontfix"],
                routes: [
                  {
                    when: ["role:ready-for-agent"],
                    actions: [
                      "github.comment-this-item",
                      "github.add-label:label:ready-for-agent",
                      "github.remove-label:label:needs-triage",
                    ],
                    handOff: null,
                  },
                  {
                    when: ["role:needs-info"],
                    actions: [
                      "github.comment-this-item",
                      "github.add-label:label:needs-info",
                      "github.remove-label:label:needs-triage",
                      "cogwork.hand-to-me",
                    ],
                    handOff: null,
                  },
                  {
                    when: ["role:ready-for-human"],
                    actions: [
                      "github.comment-this-item",
                      "github.add-label:label:ready-for-human",
                      "github.remove-label:label:needs-triage",
                      "cogwork.hand-to-me",
                    ],
                    handOff: null,
                  },
                  {
                    when: ["role:wontfix"],
                    actions: [
                      "github.comment-this-item",
                      "github.add-label:label:wontfix",
                      "github.remove-label:label:needs-triage",
                      "github.close-this-issue",
                    ],
                    handOff: null,
                  },
                ],
              },
              {
                id: "implement",
                instructionPackage: "implement-agent",
                choices: [],
                routes: [{ when: [], actions: ["github.open-pull-request"], handOff: null }],
              },
              {
                id: "follow-up",
                instructionPackage: "follow-up-agent",
                choices: ["yes", "no"],
                routes: [
                  { when: [], actions: ["github.push-to-this-pull-request"], handOff: null },
                  {
                    when: ["reply:yes"],
                    actions: ["github.comment-on-this-pull-request"],
                    handOff: null,
                  },
                ],
              },
            ],
          },
          {
            id: "linear-coding-pipeline",
            triggers: [
              { entry: "linear.issue-has-label", parameters: ["label:state:needs-triage"], start: "triage" },
              {
                entry: "linear.issue-has-label",
                parameters: ["label:state:ready-for-agent"],
                start: "implement",
              },
              {
                entry: "linear.new-comment-from-person",
                parameters: ["label:state:needs-info"],
                start: "triage",
              },
              { entry: "github.pull-request-checks-failed", parameters: [], start: "follow-up" },
              {
                entry: "github.pull-request-conflicts-with-base",
                parameters: [],
                start: "follow-up",
              },
              {
                entry: "github.new-review-comment-from-person",
                parameters: [],
                start: "follow-up",
              },
              {
                entry: "github.new-finding-from-bot",
                parameters: ["bot:cursor[bot]"],
                start: "follow-up",
              },
            ],
            operations: [
              {
                id: "triage",
                instructionPackage: "triage-agent",
                choices: ["ready-for-agent", "needs-info", "ready-for-human", "wontfix"],
                routes: [
                  {
                    when: ["role:ready-for-agent"],
                    actions: [
                      "linear.comment-this-item",
                      "linear.add-label:label:state:ready-for-agent",
                      "linear.remove-label:label:state:needs-triage",
                    ],
                    handOff: null,
                  },
                  {
                    when: ["role:needs-info"],
                    actions: [
                      "linear.comment-this-item",
                      "linear.add-label:label:state:needs-info",
                      "linear.remove-label:label:state:needs-triage",
                      "cogwork.hand-to-me",
                    ],
                    handOff: null,
                  },
                  {
                    when: ["role:ready-for-human"],
                    actions: [
                      "linear.comment-this-item",
                      "linear.add-label:label:state:ready-for-human",
                      "linear.remove-label:label:state:needs-triage",
                      "cogwork.hand-to-me",
                    ],
                    handOff: null,
                  },
                  {
                    when: ["role:wontfix"],
                    actions: [
                      "linear.comment-this-item",
                      "linear.add-label:label:state:wontfix",
                      "linear.remove-label:label:state:needs-triage",
                      "linear.close-this-issue",
                    ],
                    handOff: null,
                  },
                ],
              },
              {
                id: "implement",
                instructionPackage: "implement-agent",
                choices: [],
                routes: [{ when: [], actions: ["github.open-pull-request"], handOff: null }],
              },
              {
                id: "follow-up",
                instructionPackage: "follow-up-agent",
                choices: ["yes", "no"],
                routes: [
                  { when: [], actions: ["github.push-to-this-pull-request"], handOff: null },
                  {
                    when: ["reply:yes"],
                    actions: ["github.comment-on-this-pull-request"],
                    handOff: null,
                  },
                ],
              },
            ],
          },
        ],
      );
      yield* Effect.forEach(templates, (template) => {
        assert.deepStrictEqual(template.document.workspaces, { _tag: "Every" });
        assert.isTrue(
          template.document.operations.every(
            ({ model }) => model.harness === null && model.model === null && model.options.length === 0,
          ),
        );
        return withWorkflows(storePath, ({ create, publish }) =>
          create({ document: template.document }).pipe(
            Effect.tap((created) =>
              Effect.sync(() => {
                assert.isFalse(
                  created.diagnostics.some(
                    ({ class: diagnosticClass }) =>
                      diagnosticClass === "malformed" || diagnosticClass === "incomplete",
                  ),
                );
                if (!template.id.endsWith("-coding-pipeline")) return;
                const codes = created.diagnostics.map(({ code }) => code);
                ["hand-off-and-trigger", "unreachable-operation"].forEach((code) => {
                  assert.notInclude(codes, code);
                });
              }),
            ),
            Effect.flatMap((created) => publish({ id: created.id, revision: created.workingRevision })),
          ),
        );
      });
    }),
  );

  it.effect("starts with no Workflows and activates a coding template", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const initial = yield* withWorkflows(storePath, ({ list, templates }) =>
        Effect.all({ list, templates }),
      );
      assert.deepStrictEqual(initial.list.workflows, []);
      const template = initial.templates.find(({ id }) => id === "github-coding-pipeline");
      if (!template) return assert.fail("GitHub coding template is missing");
      yield* withWorkflows(storePath, ({ create, publish, switch: switchWorkflow }) =>
        create({ document: template.document }).pipe(
          Effect.flatMap((created) => publish({ id: created.id, revision: created.workingRevision })),
          Effect.flatMap((published) => switchWorkflow({ id: published.id, enabled: true })),
        ),
      );
      const active = yield* withWorkflows(storePath, ({ list }) => list);
      assert.isTrue(active.workflows[0]?.enabled);
      assert.isNotNull(active.workflows[0]?.publishedCopy);
    }),
  );

  it.effect("routes every Staleness sweep verdict", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const templates = (yield* withWorkflows(storePath, ({ templates }) => templates)).filter(({ id }) =>
        String(id).endsWith("-staleness-sweep"),
      );

      assert.deepStrictEqual(
        templates.map(({ id }) => id),
        ["github-staleness-sweep", "linear-staleness-sweep"],
      );
      assert.deepStrictEqual(
        templates.map(({ id, document }) => ({
          id,
          verdicts: document.operations[0]?.questions[0]?.choices.map(({ id: verdict }) => verdict),
          routes: document.operations[0]?.transitions.map(({ actions }) =>
            actions.map(({ entry, parameters }) =>
              [entry, ...parameters.map(({ value }) => value)].join(":"),
            ),
          ),
        })),
        [
          {
            id: "github-staleness-sweep",
            verdicts: ["keep", "retire", "refresh"],
            routes: [
              ["cogwork.stop"],
              ["cogwork.wait-for-approval", "github.comment-this-item", "github.close-this-issue"],
              ["github.add-label:needs-triage"],
            ],
          },
          {
            id: "linear-staleness-sweep",
            verdicts: ["keep", "retire", "refresh"],
            routes: [
              ["cogwork.stop"],
              ["cogwork.wait-for-approval", "linear.comment-this-item", "linear.close-this-issue"],
              ["linear.add-label:state:needs-triage"],
            ],
          },
        ],
      );
    }),
  );
});
