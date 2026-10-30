import { type WorkflowCatalogEntry, WorkflowCatalogKey } from "@cogwork/contracts";
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
    templates: [],
  }) satisfies WorkflowCatalogContribution;
