import { availabilityOf, WorkflowCatalogEntry } from "@cogwork/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  labelWorkspaces,
  machine,
  temporaryStore,
  unreachableWorkspace,
  withWorkflows,
} from "./workflow-fixtures";

layer(NodeServices.layer)((it) => {
  it.effect("lists both Granola Triggers with Connection availability", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const result = yield* withWorkflows(storePath, ({ catalog }) => catalog);
      const entries = result.catalog.entries.filter(({ system }) => system === "granola");

      assert.deepStrictEqual(
        entries.map(({ name }) => name),
        ["Note generated", "Note edited"],
      );
      assert.deepStrictEqual(
        entries.map((entry) => availabilityOf(entry, result.machine)),
        [
          { _tag: "Unavailable", reason: "Granola login expired" },
          { _tag: "Unavailable", reason: "Granola login expired" },
        ],
      );
    }),
  );

  it.effect("returns catalog content and machine state separately", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const result = yield* withWorkflows(storePath, ({ catalog }) => catalog);

      assert.deepStrictEqual(result.catalog.instructionPackages, [
        "triage-agent",
        "implement-agent",
        "follow-up-agent",
      ]);
      assert.deepStrictEqual(result.machine, machine);
    }),
  );

  it.effect("lists live schedule zones through the Workflow catalog", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const options = yield* withWorkflows(storePath, ({ listOptions }) =>
        listOptions({
          entry: Schema.decodeSync(WorkflowCatalogEntry.fields.key)("schedule.daily"),
          parameter: "zone",
          workspaces: [],
        }),
      );

      assert.include(
        options.map(({ value }) => value),
        "America/New_York",
      );
    }),
  );

  it.effect("lists a system's labels for an action whose contribution reads no options", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const [first, second] = labelWorkspaces;
      const options = yield* withWorkflows(storePath, ({ listOptions }) =>
        listOptions({
          entry: Schema.decodeSync(WorkflowCatalogEntry.fields.key)("github.add-label"),
          parameter: "label",
          workspaces: [first, second, unreachableWorkspace],
        }),
      );

      assert.deepStrictEqual(options, [
        { value: "needs-triage", name: "needs-triage", listedIn: [first, second] },
        { value: "first", name: "first", listedIn: [first] },
        { value: "second", name: "second", listedIn: [second] },
      ]);
    }),
  );

  it.effect("lists live sweep idle days through the Workflow catalog", () =>
    Effect.gen(function* () {
      const storePath = yield* temporaryStore();
      const options = yield* withWorkflows(storePath, ({ listOptions }) =>
        listOptions({
          entry: Schema.decodeSync(WorkflowCatalogEntry.fields.key)("schedule.sweep"),
          parameter: "idle-days",
          workspaces: [],
        }),
      );

      assert.include(
        options.map(({ value }) => value),
        "30",
      );
    }),
  );
});
