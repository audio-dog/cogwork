import { type WorkflowCatalogEntry, WorkflowCatalogKey, WorkflowTemplate } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import type { WorkflowCatalogContribution } from "./workflow-catalog";

const key = Schema.decodeSync(WorkflowCatalogKey);

const parameter = (id: string, required: boolean) =>
  ({
    id,
    required,
    source: "live",
    values: [],
  }) satisfies WorkflowCatalogEntry["parameters"][number];

const action = (
  system: string,
  id: string,
  name: string,
  agentInputs: ReadonlyArray<string>,
  parameters: WorkflowCatalogEntry["parameters"] = [],
  actsOn: ReadonlyArray<string> = ["*"],
) =>
  ({
    key: key(`${system}.${id}`),
    name,
    kind: "action",
    system,
    connection: system,
    requires: [],
    parameters,
    itemKind: null,
    actsOn,
    requiresWorkspace: true,
    permissionProfile: "read-only",
    agentInputs,
    emits: [],
  }) satisfies WorkflowCatalogEntry;

const trackerTemplate = {
  github: { name: "GitHub", refreshLabel: "needs-triage" },
  linear: { name: "Linear", refreshLabel: "state:needs-triage" },
} as const;

const stalenessSweepTemplate = (system: "github" | "linear") => {
  const tracker = trackerTemplate[system];
  return Schema.decodeSync(WorkflowTemplate)({
    id: `${system}-staleness-sweep`,
    name: `${tracker.name} staleness sweep`,
    description: "Review parked issues and keep, retire, or refresh each one.",
    document: {
      name: `${tracker.name} staleness sweep`,
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
                  parameters: [{ id: "label", value: tracker.refreshLabel }],
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

export const issueTrackerWorkflowCatalogContribution = (system: "github" | "linear") =>
  ({
    entries: [
      action(
        system,
        "create-issue",
        "Create an issue",
        ["issue_title", "issue_body"],
        [parameter("label", false)],
      ),
      action(system, "comment-this-item", "Comment on this item", ["comment"], [], ["issue"]),
      action(system, "comment-issue", "Comment on an existing issue", ["issue", "comment"]),
      action(system, "add-label", "Add a label", [], [parameter("label", true)], ["issue"]),
      action(system, "remove-label", "Remove a label", [], [parameter("label", true)], ["issue"]),
      action(system, "close-this-issue", "Close this issue", [], [], ["issue"]),
    ],
    templates: [stalenessSweepTemplate(system)],
  }) satisfies WorkflowCatalogContribution;
