import { fileURLToPath } from "node:url";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/process/ChildProcess";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";

const target = fileURLToPath(new URL("../src/models.generated.ts", import.meta.url));
const check = process.argv.includes("--check");
const commandDeadline = "5 seconds";

class StaleModelCatalog extends Data.TaggedError("StaleModelCatalog")<{ readonly message: string }> {}
const effortValues = ["low", "medium", "high", "xhigh", "max"] as const;
const modelSpecs = [
  ["sonnet", "Sonnet", true, "full"],
  ["opus", "Opus", false, "full"],
  ["haiku", "Haiku", false, "none"],
  ["fable", "Fable", false, "full"],
  ["best", "Best", false, "full"],
  ["claude-fable-5-1", "Claude Fable 5.1", false, "full"],
  ["claude-fable-5", "Claude Fable 5", false, "full"],
  ["claude-opus-5", "Claude Opus 5", false, "full"],
  ["claude-opus-4-8", "Claude Opus 4.8", false, "full"],
  ["claude-opus-4-7", "Claude Opus 4.7", false, "opus47"],
  ["claude-opus-4-6", "Claude Opus 4.6", false, "limited"],
  ["claude-sonnet-5", "Claude Sonnet 5", false, "full"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6", false, "limited"],
  ["claude-haiku-4-5", "Claude Haiku 4.5", false, "none"],
] as const;

const parseEffortValues = (help: string) =>
  help
    .match(/--effort <level>[\s\S]*?\(([^)]+)\)/)?.[1]
    ?.split(",")
    .map((value) => value.trim()) ?? [];

const render = (generatedAgainst: string) => {
  const renderedEffortValues = effortValues.map((value) => JSON.stringify(value)).join(", ");
  const renderedSpecs = modelSpecs
    .map(
      ([value, label, defaultModel, options]) =>
        `  [${JSON.stringify(value)}, ${JSON.stringify(label)}, ${defaultModel}, ${JSON.stringify(options)}],`,
    )
    .join("\n");
  return `import type {
  HarnessManagedCatalog,
  HarnessManagedCatalogModel,
  HarnessModelOptionDescriptor,
} from "@cogwork/contracts";

type SelectOption = Extract<HarnessModelOptionDescriptor, { type: "select" }>;
const effortLabels = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
} as const;
const effortOption = (values: ReadonlyArray<keyof typeof effortLabels>, defaultValue: string) =>
  ({
    type: "select" as const,
    id: "effort",
    label: "Effort",
    values: values.map((value) => ({ value, label: effortLabels[value] })),
    defaultValue,
  }) satisfies SelectOption;
const contextOption = {
  type: "boolean",
  id: "context",
  label: "1M Context",
  defaultValue: false,
} as const;
export const claudeEfforts = [${renderedEffortValues}] as const;
const limitedEffort = ["low", "medium", "high", "max"] as const;
const optionsByKind = {
  full: [effortOption(claudeEfforts, "high"), contextOption],
  opus47: [effortOption(claudeEfforts, "xhigh"), contextOption],
  limited: [effortOption(limitedEffort, "high"), contextOption],
  none: undefined,
} as const;
const modelSpecs = [
${renderedSpecs}
] as const;
const models = modelSpecs.map(([value, label, defaultModel, options]) => ({
  value,
  label,
  default: defaultModel,
  ...(optionsByKind[options] ? { options: optionsByKind[options] } : {}),
})) satisfies ReadonlyArray<HarnessManagedCatalogModel>;
const defaultOptions = (entry: HarnessManagedCatalogModel) =>
  Object.fromEntries((entry.options ?? []).map(({ id, defaultValue }) => [id, defaultValue]));

export const claudeModelCatalog = {
  models,
  generatedAgainst: ${JSON.stringify(generatedAgainst)},
  rawModelIds: models.map(({ value }) => value),
  rawModelSelections: Object.fromEntries(
    models.map((entry) => [entry.value, { model: entry.value, options: defaultOptions(entry) }]),
  ),
} satisfies HarnessManagedCatalog;

export type ClaudeCatalogModel = (typeof claudeModelCatalog.models)[number]["value"];
`;
};

const commandOutput = Effect.fn("ClaudeModelSync.commandOutput")(function* (
  command: ChildProcess.Command,
  label: string,
) {
  const spawner = yield* ChildProcessSpawner;
  const result = yield* Effect.scoped(
    Effect.flatMap(spawner.spawn(command), (handle) =>
      Effect.all(
        { stdout: Stream.mkString(Stream.decodeText(handle.stdout)), exitCode: handle.exitCode },
        { concurrency: "unbounded" },
      ),
    ),
  ).pipe(
    Effect.timeoutOrElse({
      duration: commandDeadline,
      orElse: () => Effect.die(`${label} timed out after ${commandDeadline}`),
    }),
  );
  if (result.exitCode === 0) return result.stdout;
  return yield* Effect.die(`${label} exited with ${result.exitCode}`);
});

const claudeOutput = (claudeBin: string, args: ReadonlyArray<string>) =>
  commandOutput(
    ChildProcess.make(claudeBin, [...args], { stdin: "ignore", stderr: "inherit" }),
    `${claudeBin} ${args.join(" ")}`,
  );

NodeRuntime.runMain(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const claudeBin = yield* Config.String("CLAUDE_CODE_BIN").pipe(Config.withDefault("claude"));
    const version = (yield* claudeOutput(claudeBin, ["--version"])).trim();
    const nativeEffortValues = parseEffortValues(yield* claudeOutput(claudeBin, ["--help"]));
    if (nativeEffortValues.join() !== effortValues.join()) {
      return yield* Effect.die(
        `Expected Claude effort levels ${effortValues.join(", ")}; received ${nativeEffortValues.join(", ")}`,
      );
    }
    const file = render(version);
    if (!check) {
      yield* fs.writeFileString(target, file);
      return yield* Console.log(
        `Wrote ${modelSpecs.length} Claude models generated against ${version} to ${target}`,
      );
    }
    if ((yield* fs.readFileString(target)) === file) {
      return yield* Console.log(
        `Claude model catalog is in sync (${modelSpecs.length} models, Claude Code ${version}).`,
      );
    }
    return yield* new StaleModelCatalog({
      message: "Claude model catalog is stale. Run `pnpm --filter @cogwork/claude-code models:sync`.",
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
