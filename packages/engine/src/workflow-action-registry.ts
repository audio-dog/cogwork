import { type ActionEntry, type ActionPhase, actionPhases } from "./workflow-action-entry";
import { cogworkActionEntries } from "./workflow-actions-cogwork";

const actionEntries: ReadonlyMap<string, ActionEntry> = new Map(Object.entries(cogworkActionEntries));

export const actionEntryFor = (key: string) => actionEntries.get(key);

export const registeredActionRows = [...actionEntries.values()].map(({ row }) => row);

const phaseOf = (key: string): ActionPhase => actionEntryFor(key)?.phase ?? "write";

export const compareActionPhase = (left: string, right: string) =>
  actionPhases.indexOf(phaseOf(left)) - actionPhases.indexOf(phaseOf(right));
