import { type WorkflowCatalogEntry, WorkflowCatalogKey, WorkflowTemplate } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import type { WorkflowCatalogContribution } from "./workflow-catalog";

const key = Schema.decodeSync(WorkflowCatalogKey);
const decodeTemplate = Schema.decodeUnknownSync(WorkflowTemplate);

const trackerNames = {
  github: "GitHub",
  linear: "Linear",
} as const;

const triageLabels = {
  github: "needs-triage",
  linear: "state:needs-triage",
} as const;

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
    templates: [granolaIssueTemplate(system)],
  }) satisfies WorkflowCatalogContribution;
