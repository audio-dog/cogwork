import type { WorkflowDocument } from "./workflow";
import {
  type MachineReadiness,
  WorkflowAvailability,
  type WorkflowCatalog,
  type WorkflowCatalogEntry,
} from "./workflow-catalog";
import { diagnostic, location } from "./workflow-diagnostic";
import { entryUsages } from "./workflow-validation";

const optionReadinessDiagnostics = (document: WorkflowDocument, catalog: WorkflowCatalog) => {
  const entries = new Map(catalog.entries.map((entry) => [entry.key, entry]));
  return entryUsages(document).flatMap((usage) => {
    const entry = entries.get(usage.entry);
    if (!entry) return [];
    return usage.parameters.flatMap(({ id, value }) => {
      const parameter = entry.parameters.find((candidate) => candidate.id === id);
      // A source lists most live values only on request, so an empty catalog list says nothing.
      const missingLiveValue =
        parameter?.source === "live" && parameter.values.length > 0 && !parameter.values.includes(value);
      return missingLiveValue
        ? [
            diagnostic(
              "option-not-listed",
              "advisory",
              `Parameter ${id} does not list ${value}`,
              usage.location,
            ),
          ]
        : [];
    });
  });
};

const workspaceReadinessDiagnostics = (document: WorkflowDocument, machine: MachineReadiness) => {
  const selected = document.workspaces._tag === "Listed" ? document.workspaces.workspaces : [];
  const workspaceIds = machine.workspaces.map(({ id }) => id);
  const registered = selected.flatMap((workspace) =>
    workspaceIds.includes(workspace)
      ? []
      : [
          diagnostic(
            "workspace-not-registered",
            "advisory",
            `Workspace ${workspace} is not registered`,
            location("workspaces"),
          ),
        ],
  );
  return registered;
};

const bindingReadinessDiagnostics = (
  document: WorkflowDocument,
  catalog: WorkflowCatalog,
  machine: MachineReadiness,
) => {
  const selected = document.workspaces._tag === "Listed" ? document.workspaces.workspaces : [];
  return entryUsages(document).flatMap((usage) => {
    const system = catalog.entries.find(({ key }) => key === usage.entry)?.system;
    if (system === null || system === undefined) return [];
    const bound = machine.workspaces.filter(({ binds }) => binds.includes(system)).map(({ id }) => id);
    const selection =
      document.workspaces._tag === "Every" ? machine.workspaces.map(({ id }) => id) : selected;
    const observed = selection.filter((workspace) => bound.includes(workspace)).length;
    const messages = [
      { when: observed === 0, value: `No selected Workspace binds ${system}` },
      {
        when: observed > 0 && observed < selection.length,
        value: `${usage.entry} observes in ${observed} of ${selection.length} Workspaces`,
      },
    ];
    const message = messages.find(({ when }) => when)?.value;
    return message === undefined ? [] : [diagnostic("system-unbound", "advisory", message, usage.location)];
  });
};

interface AvailabilityInput {
  readonly entry: WorkflowCatalogEntry;
  readonly connection: MachineReadiness["connections"][number] | undefined;
}

const availabilityRules = [
  {
    matches: ({ entry }: AvailabilityInput) => entry.connection === null && entry.system === null,
    make: (_input: AvailabilityInput) => ({ _tag: "Available" }) as const,
  },
  {
    matches: ({ connection }: AvailabilityInput) => connection === undefined,
    make: (_input: AvailabilityInput) => ({ _tag: "ConnectionNeeded" }) as const,
  },
  {
    matches: ({ connection }: AvailabilityInput) => connection?.ready === true,
    make: (_input: AvailabilityInput) => ({ _tag: "Available" }) as const,
  },
  {
    matches: ({ connection }: AvailabilityInput) => connection?.reason === null,
    make: (_input: AvailabilityInput) => ({ _tag: "ConnectionNeeded" }) as const,
  },
] satisfies ReadonlyArray<{
  readonly matches: (input: AvailabilityInput) => boolean;
  readonly make: (input: AvailabilityInput) => WorkflowAvailability;
}>;

export const availabilityOf = (
  entry: WorkflowCatalogEntry,
  machine: MachineReadiness,
): WorkflowAvailability => {
  const input = {
    entry,
    connection: machine.connections.find(({ system }) => system === entry.system),
  };
  return (
    availabilityRules.find(({ matches }) => matches(input))?.make(input) ?? {
      _tag: "Unavailable",
      reason: input.connection?.reason ?? "Connection unavailable",
    }
  );
};

const connectionReadinessDiagnostics = (
  document: WorkflowDocument,
  catalog: WorkflowCatalog,
  machine: MachineReadiness,
) => {
  const entries = new Map(catalog.entries.map((entry) => [entry.key, entry]));
  return entryUsages(document).flatMap((usage) => {
    const entry = entries.get(usage.entry);
    if (!entry) return [];
    return WorkflowAvailability.match(availabilityOf(entry, machine), {
      Available: () => [],
      ConnectionNeeded: () => [
        diagnostic(
          "connection-not-ready",
          "advisory",
          `Connection for ${entry.system ?? entry.connection ?? entry.key} is needed`,
          usage.location,
        ),
      ],
      Unavailable: ({ reason }) => [diagnostic("connection-not-ready", "advisory", reason, usage.location)],
    });
  });
};

const needReadinessDiagnostics = (document: WorkflowDocument, machine: MachineReadiness) =>
  document.operations.flatMap((operation) =>
    operation.requires.flatMap((need) =>
      machine.readyNeeds.includes(need)
        ? []
        : [
            diagnostic(
              "need-not-ready",
              "advisory",
              `Need ${need} is not ready`,
              location("requires", { operation: operation.id }),
            ),
          ],
    ),
  );

const harnessReadinessDiagnostics = (document: WorkflowDocument, machine: MachineReadiness) =>
  document.operations.flatMap((operation) => {
    const harness = operation.model.harness ?? machine.defaultHarness;
    if (harness === null) {
      return [
        diagnostic(
          "no-harness",
          "advisory",
          `Operation ${operation.id} has no Harness`,
          location("model", { operation: operation.id }),
        ),
      ];
    }
    const available = machine.harnesses.find(({ name }) => name === harness)?.available ?? false;
    return available
      ? []
      : [
          diagnostic(
            "harness-unavailable",
            "advisory",
            `Harness ${harness} is unavailable`,
            location("model", { operation: operation.id }),
          ),
        ];
  });

export const adviseReadiness = (
  document: WorkflowDocument,
  catalog: WorkflowCatalog,
  machine: MachineReadiness,
) => [
  ...connectionReadinessDiagnostics(document, catalog, machine),
  ...needReadinessDiagnostics(document, machine),
  ...harnessReadinessDiagnostics(document, machine),
  ...workspaceReadinessDiagnostics(document, machine),
  ...bindingReadinessDiagnostics(document, catalog, machine),
  ...optionReadinessDiagnostics(document, catalog),
];
