import { useState } from "react";
import { type CatalogChoice, choiceKey, isHandOff } from "./workflow-catalog";
import { blankOperation, type Operation, operationEdits, type Workflow } from "./workflow-model";

/**
 * The one working copy of a Workflow while it is edited. Every edit — the header, the Triggers, each
 * Operation and its outcomes — lands here, so saving reads a single value. Nothing persists yet.
 */

/** Hand-offs name their target, so a renamed or removed Operation changes every route that points at it. */
const mapHandOffs = (
  operation: Operation,
  targetId: string,
  change: (step: CatalogChoice) => CatalogChoice | null,
): Operation => ({
  ...operation,
  routes: operation.routes.map((route) => ({
    ...route,
    steps: route.steps.flatMap((step) => {
      if (!isHandOff(step) || step.itemId !== targetId) return [step];
      const next = change(step);
      return next ? [next] : [];
    }),
  })),
});

/** Every change the editor makes to a Workflow, as a pure function of the Workflow it changes. */
export const workflowEdits = {
  rename: (workflow: Workflow, name: string): Workflow => ({ ...workflow, name }),
  setEnabled: (workflow: Workflow, enabled: boolean): Workflow => ({ ...workflow, enabled }),
  setWorkspaces: (workflow: Workflow, workspaces: readonly string[]): Workflow => ({
    ...workflow,
    workspaces,
  }),
  addTrigger: (workflow: Workflow, trigger: CatalogChoice): Workflow => ({
    ...workflow,
    triggers: [...workflow.triggers, trigger],
  }),
  removeTrigger: (workflow: Workflow, trigger: CatalogChoice): Workflow => ({
    ...workflow,
    triggers: workflow.triggers.filter((existing) => choiceKey(existing) !== choiceKey(trigger)),
  }),
  addOperation: (workflow: Workflow): Workflow => ({
    ...workflow,
    operations: [
      ...workflow.operations,
      blankOperation(workflow.operations.map((operation) => operation.id)),
    ],
  }),
  removeOperation: (workflow: Workflow, id: string): Workflow => ({
    ...workflow,
    operations: workflow.operations
      .filter((operation) => operation.id !== id)
      .map((operation) => mapHandOffs(operation, id, () => null)),
  }),
  renameOperation: (workflow: Workflow, id: string, name: string): Workflow => ({
    ...workflow,
    operations: workflow.operations.map((operation) =>
      mapHandOffs(operation.id === id ? operationEdits.rename(operation, name) : operation, id, (step) => ({
        ...step,
        itemName: name,
      })),
    ),
  }),
  updateOperation: (workflow: Workflow, id: string, edit: (operation: Operation) => Operation): Workflow => ({
    ...workflow,
    operations: workflow.operations.map((operation) => (operation.id === id ? edit(operation) : operation)),
  }),
};

export function useWorkflowDraft(seed: Workflow) {
  const [workflow, setWorkflow] = useState(seed);
  const actions = {
    rename: (name: string) => setWorkflow((current) => workflowEdits.rename(current, name)),
    setEnabled: (enabled: boolean) => setWorkflow((current) => workflowEdits.setEnabled(current, enabled)),
    setWorkspaces: (workspaces: readonly string[]) =>
      setWorkflow((current) => workflowEdits.setWorkspaces(current, workspaces)),
    addTrigger: (trigger: CatalogChoice) =>
      setWorkflow((current) => workflowEdits.addTrigger(current, trigger)),
    removeTrigger: (trigger: CatalogChoice) =>
      setWorkflow((current) => workflowEdits.removeTrigger(current, trigger)),
    addOperation: () => setWorkflow((current) => workflowEdits.addOperation(current)),
    removeOperation: (id: string) => setWorkflow((current) => workflowEdits.removeOperation(current, id)),
    renameOperation: (id: string, name: string) =>
      setWorkflow((current) => workflowEdits.renameOperation(current, id, name)),
    updateOperation: (id: string, edit: (operation: Operation) => Operation) =>
      setWorkflow((current) => workflowEdits.updateOperation(current, id, edit)),
  };
  return { workflow, actions };
}

export type WorkflowDraftActions = ReturnType<typeof useWorkflowDraft>["actions"];
