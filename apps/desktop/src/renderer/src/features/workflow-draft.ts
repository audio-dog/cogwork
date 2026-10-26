import { useState } from "react";
import { type CatalogChoice, isHandOff, sameChoice } from "./workflow-catalog";
import {
  blankOperation,
  type Operation,
  operationEdits,
  type Workflow,
  type WorkspaceScope,
} from "./workflow-model";

export const bindEdits =
  <T>(update: (change: (current: T) => T) => void) =>
  <Args extends readonly unknown[]>(edit: (current: T, ...args: Args) => T) =>
  (...args: Args) =>
    update((current) => edit(current, ...args));

const mapHandOffsTo = (
  operation: Operation,
  targetId: string,
  change: (action: CatalogChoice) => CatalogChoice | null,
) => ({
  ...operation,
  routes: operation.routes.map((route) => ({
    ...route,
    actions: route.actions.flatMap((action) => {
      if (!isHandOff(action) || action.itemId !== targetId) return [action];
      const next = change(action);
      return next ? [next] : [];
    }),
  })),
});

const updateWhere = (
  operations: readonly Operation[],
  id: string,
  edit: (operation: Operation) => Operation,
) => operations.map((operation) => (operation.id === id ? edit(operation) : operation));

export const workflowEdits = {
  rename: (workflow: Workflow, name: string) => ({ ...workflow, name }),
  setEnabled: (workflow: Workflow, enabled: boolean) => ({ ...workflow, enabled }),
  setWorkspaces: (workflow: Workflow, workspaces: WorkspaceScope) => ({ ...workflow, workspaces }),
  addTrigger: (workflow: Workflow, trigger: CatalogChoice) => ({
    ...workflow,
    triggers: workflow.triggers.some((existing) => sameChoice(existing, trigger))
      ? workflow.triggers
      : [...workflow.triggers, trigger],
  }),
  removeTrigger: (workflow: Workflow, trigger: CatalogChoice) => ({
    ...workflow,
    triggers: workflow.triggers.filter((existing) => !sameChoice(existing, trigger)),
  }),
  addOperation: (workflow: Workflow) => ({
    ...workflow,
    operations: [
      ...workflow.operations,
      blankOperation(workflow.operations.map((operation) => operation.id)),
    ],
  }),
  removeOperation: (workflow: Workflow, id: string) => ({
    ...workflow,
    operations: workflow.operations
      .filter((operation) => operation.id !== id)
      .map((operation) => mapHandOffsTo(operation, id, () => null)),
  }),
  renameOperation: (workflow: Workflow, id: string, name: string) => ({
    ...workflow,
    operations: updateWhere(workflow.operations, id, (operation) =>
      operationEdits.rename(operation, name),
    ).map((operation) => mapHandOffsTo(operation, id, (action) => ({ ...action, itemName: name }))),
  }),
  updateOperation: (workflow: Workflow, id: string, edit: (operation: Operation) => Operation) => ({
    ...workflow,
    operations: updateWhere(workflow.operations, id, edit),
  }),
};

export function useWorkflowDraft(seed: Workflow) {
  const [workflow, setWorkflow] = useState(seed);
  const bind = bindEdits(setWorkflow);
  const actions = {
    rename: bind(workflowEdits.rename),
    setEnabled: bind(workflowEdits.setEnabled),
    setWorkspaces: bind(workflowEdits.setWorkspaces),
    addTrigger: bind(workflowEdits.addTrigger),
    removeTrigger: bind(workflowEdits.removeTrigger),
    addOperation: bind(workflowEdits.addOperation),
    removeOperation: bind(workflowEdits.removeOperation),
    renameOperation: bind(workflowEdits.renameOperation),
    updateOperation: bind(workflowEdits.updateOperation),
  };
  return { workflow, actions };
}

export type WorkflowDraftActions = ReturnType<typeof useWorkflowDraft>["actions"];
