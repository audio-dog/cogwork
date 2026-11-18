import { type ActionEntry, type ActionPhase, actionPhases } from "./workflow-action-entry";
import { cogworkActionEntries } from "./workflow-actions-cogwork";
import { issueActionEntries } from "./workflow-actions-issue";
import { slackWriteActionEntries } from "./workflow-actions-slack";
import { sourceControlActionEntries } from "./workflow-actions-source-control";

const actionEntries: ReadonlyMap<string, ActionEntry> = new Map([
  ...Object.entries(cogworkActionEntries),
  ...[...issueActionEntries, ...sourceControlActionEntries, ...slackWriteActionEntries].map(
    (entry) => [entry.row.key, entry] as const,
  ),
]);

export const actionEntryFor = (key: string) => actionEntries.get(key);

export const registeredActionRows = [...actionEntries.values()].map(({ row }) => row);

export const registeredActionRowsFor = (system: string | null) =>
  registeredActionRows.filter((row) => row.system === system);

const phaseOf = (key: string): ActionPhase => actionEntryFor(key)?.phase ?? "write";

export const compareActionPhase = (left: string, right: string) =>
  actionPhases.indexOf(phaseOf(left)) - actionPhases.indexOf(phaseOf(right));
