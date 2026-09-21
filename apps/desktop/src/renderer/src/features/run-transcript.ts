import type { RunStatus } from "@cogwork/contracts";
import {
  RiBrainLine,
  RiCloudLine,
  RiDeleteBinLine,
  RiFileEditLine,
  RiFileTextLine,
  RiGitBranchLine,
  RiSearchLine,
  RiTerminalBoxLine,
  RiTestTubeLine,
} from "@remixicon/react";
import type { ComponentType } from "react";
import type { TranscriptEntry } from "./run-activity";

/**
 * A harness puts three shapes on the wire that the AG-UI types do not describe,
 * and reading any of them as a plain string puts raw JSON on the screen:
 * a tool result rides on `content` as a JSON string holding
 * `{aggregated_output, exit_code, status}`; assistant text is the stage result
 * object (`{_tag, summary}`) rather than prose; and a file edit arrives as
 * `{changes:[{path, kind}]}` instead of a command.
 */

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown) => (typeof value === "string" ? value : "");

const firstLine = (value: string) => value.split("\n", 1)[0] ?? "";

export const stageNote = (text: string) => {
  const value = parseJson(text.trim());
  if (!isRecord(value)) return null;
  if (!asString(value._tag)) return null;
  return asString(value.summary) || asString(value.proposal) || null;
};

const unwrapShell = (command: string) => {
  const inner = /^\s*(?:\S*\/)?(?:sh|zsh|bash)\s+-[a-z]*c\s+(.*)$/s.exec(command)?.[1]?.trim();
  if (!inner) return command.trim();
  const quote = inner[0];
  if (quote !== "'" && quote !== '"') return inner;
  const body = inner.endsWith(quote) && inner.length > 1 ? inner.slice(1, -1) : inner.slice(1);
  return body.replaceAll(`\\${quote}`, quote).trim();
};

const homePath = /(?:\/Users|\/home)\/[^/\s'"]+\//g;
const worktreePath = /\.worktrees\/[^/]+\/(.*)$/s;

export const repoRelative = (path: string) => worktreePath.exec(path)?.[1] ?? path.replace(homePath, "~/");

const commandFrom = (parsed: unknown, raw: string) => {
  if (!isRecord(parsed)) return unwrapShell(raw).replace(homePath, "~/");
  const command = asString(parsed.command);
  return command ? unwrapShell(command).replace(homePath, "~/") : "";
};

export const commandOf = (args: string) => commandFrom(parseJson(args), args);

const programs = [
  { match: /^(?:rg|grep|ag|fd|find)\b/, label: "Searched", icon: RiSearchLine },
  { match: /^(?:cat|sed|head|tail|nl|less|bat)\b/, label: "Read", icon: RiFileTextLine },
  { match: /^git\b/, label: "Git", icon: RiGitBranchLine },
  { match: /^gh\b/, label: "GitHub", icon: RiCloudLine },
  { match: /^(?:pnpm|npm|yarn|bun|node|vitest|tsc)\b/, label: "Ran", icon: RiTestTubeLine },
] as const;

const shellRun = { label: "Ran", icon: RiTerminalBoxLine };

const programOf = (command: string) => {
  const head = command.replace(/^\(\s*/, "").trimStart();
  return programs.find((program) => program.match.test(head)) ?? shellRun;
};

const maxOutput = 8000;

const clip = (value: string) =>
  value.length > maxOutput
    ? { output: `${value.slice(0, maxOutput)}\n…`, clippedFrom: value.length }
    : { output: value, clippedFrom: 0 };

const shellResult = (content: string | null) => {
  if (!content) return null;
  const value = parseJson(content);
  if (!isRecord(value)) return { ...clip(content), failed: false };
  const exitCode = typeof value.exit_code === "number" ? value.exit_code : 0;
  const failed = exitCode !== 0 || asString(value.status) === "failed";
  const output =
    "aggregated_output" in value ? asString(value.aggregated_output) : JSON.stringify(value, null, 2);
  return { ...clip(output), failed };
};

const fileChanges = (parsed: unknown) => {
  if (!isRecord(parsed) || !Array.isArray(parsed.changes)) return [];
  return parsed.changes.flatMap((change) => {
    if (!isRecord(change)) return [];
    const path = asString(change.path);
    return path ? [{ path, kind: asString(change.kind) || "update" }] : [];
  });
};

type FileChange = ReturnType<typeof fileChanges>[number];

const changeTarget = (changes: readonly FileChange[]) => {
  const head = changes[0] ? repoRelative(changes[0].path) : "";
  return changes.length > 1 ? `${head} +${changes.length - 1} more` : head;
};

export type StepStatus = "running" | "done" | "failed";

export interface StepView {
  readonly key: string;
  readonly label: string;
  readonly target: string;
  readonly detail: string;
  readonly icon: ComponentType<{ className?: string }>;
  readonly status: StepStatus;
  readonly note: string | null;
}

type StepEntry = Extract<TranscriptEntry, { kind: "reasoning" | "tool" | "diff" }>;

const isStep = (entry: TranscriptEntry): entry is StepEntry =>
  entry.kind === "reasoning" || entry.kind === "tool" || entry.kind === "diff";

const reasoningView = (entry: Extract<StepEntry, { kind: "reasoning" }>): StepView => {
  const head = firstLine(entry.text);
  return {
    key: entry.key,
    label: "Thought",
    target: head,
    detail: entry.text.slice(head.length).trim(),
    icon: RiBrainLine,
    status: "done",
    note: null,
  };
};

const diffView = (entry: Extract<StepEntry, { kind: "diff" }>): StepView => ({
  key: entry.key,
  label: "Edited",
  target: repoRelative(entry.path),
  detail: entry.diff,
  icon: RiFileEditLine,
  status: "done",
  note: null,
});

const changeView = (
  entry: Extract<StepEntry, { kind: "tool" }>,
  changes: readonly FileChange[],
  complete: boolean,
): StepView => {
  const deleted = changes.every((change) => change.kind === "delete");
  const failed = shellResult(entry.result)?.failed ?? false;
  return {
    key: entry.key,
    label: deleted ? "Deleted" : "Edited",
    target: changeTarget(changes),
    detail: changes.map((change) => `${change.kind.padEnd(7)}${repoRelative(change.path)}`).join("\n"),
    icon: deleted ? RiDeleteBinLine : RiFileEditLine,
    status: commandStatus(complete, failed),
    note: null,
  };
};

const commandStatus = (complete: boolean, failed: boolean): StepStatus => {
  if (!complete) return "running";
  return failed ? "failed" : "done";
};

const commandView = (
  entry: Extract<StepEntry, { kind: "tool" }>,
  command: string,
  complete: boolean,
): StepView => {
  const program = programOf(command);
  const result = shellResult(entry.result);
  return {
    key: entry.key,
    label: program.label,
    target: command,
    detail: result?.output ?? "",
    icon: program.icon,
    status: commandStatus(complete, result?.failed ?? false),
    note: result?.clippedFrom ? `Clipped from ${result.clippedFrom.toLocaleString()} characters` : null,
  };
};

const toolView = (entry: Extract<StepEntry, { kind: "tool" }>, complete: boolean): StepView => {
  const parsedArgs = parseJson(entry.args);
  const changes = fileChanges(parsedArgs);
  if (changes.length > 0) return changeView(entry, changes, complete);
  const command = commandFrom(parsedArgs, entry.args);
  if (command) return commandView(entry, command, complete);
  return { ...commandView(entry, "", complete), label: "Ran", target: entry.name };
};

const stepView = (entry: StepEntry, runComplete: boolean): StepView => {
  if (entry.kind === "reasoning") return reasoningView(entry);
  if (entry.kind === "diff") return diffView(entry);
  return toolView(entry, entry.complete || runComplete);
};

export const stepBody = (view: StepView) =>
  [view.target, view.detail].filter((block) => block.trim().length > 0).join("\n\n");

export type TranscriptRow =
  | {
      readonly kind: "work";
      readonly key: string;
      readonly steps: readonly StepView[];
      readonly foldNoun: "tool call" | "step";
    }
  | { readonly kind: "note"; readonly key: string; readonly text: string }
  | { readonly kind: "warning"; readonly key: string; readonly message: string }
  | { readonly kind: "error"; readonly key: string; readonly message: string };

const groupEntries = (entries: Iterable<TranscriptEntry>) =>
  Array.from(entries).reduce<TranscriptEntry[][]>((groups, entry) => {
    const group = groups.at(-1);
    if (isStep(entry) && group?.every(isStep)) group.push(entry);
    else groups.push([entry]);
    return groups;
  }, []);

const noteRow = (entry: Extract<TranscriptEntry, { kind: "text" }>): TranscriptRow | null => {
  const note = stageNote(entry.text);
  if (note) return { kind: "note", key: entry.key, text: note };
  if (entry.text.trimStart().startsWith("{")) return null;
  return { kind: "note", key: entry.key, text: entry.text };
};

const toRow = (group: readonly TranscriptEntry[], runComplete: boolean): TranscriptRow | null => {
  const [first] = group;
  if (!first) return null;
  if (first.kind === "error") return { kind: "error", key: first.key, message: first.message };
  if (first.kind === "warning") return { kind: "warning", key: first.key, message: first.message };
  if (first.kind === "text") return noteRow(first);
  const steps = group.filter(isStep);
  return {
    kind: "work",
    key: first.key,
    steps: steps.map((entry) => stepView(entry, runComplete)),
    foldNoun: steps.every((entry) => entry.kind === "tool") ? "tool call" : "step",
  };
};

export const transcriptRows = (entries: Iterable<TranscriptEntry>, runComplete: boolean) =>
  groupEntries(entries).flatMap((group) => toRow(group, runComplete) ?? []);

const terminalLine: Partial<Record<RunStatus, string>> = {
  succeeded: "Run finished.",
  declined: "Pull request creation declined.",
  failed: "Run failed.",
  crashed: "Run failed.",
  exhausted: "Run failed.",
  interrupted: "Run interrupted.",
};

const maxLineTarget = 72;

const clipTarget = (target: string) =>
  target.length > maxLineTarget ? `${target.slice(0, maxLineTarget - 1)}…` : target;

const workLine = (steps: readonly StepView[]) => {
  const latest = steps.at(-1);
  if (!latest) return "Working…";
  return latest.status === "running"
    ? `Running ${clipTarget(latest.target)}…`
    : `Ran ${clipTarget(latest.target)}`;
};

export const runLine = (rows: readonly TranscriptRow[], status: RunStatus) => {
  const terminal = terminalLine[status];
  if (terminal) return terminal;
  const last = rows.at(-1);
  if (!last) return "Starting…";
  if (last.kind === "note") return firstLine(last.text);
  if (last.kind === "error" || last.kind === "warning") return last.message;
  return workLine(last.steps);
};

export const statusLine = (entries: Iterable<TranscriptEntry>, status: RunStatus) =>
  runLine(transcriptRows(entries, status !== "running"), status);
