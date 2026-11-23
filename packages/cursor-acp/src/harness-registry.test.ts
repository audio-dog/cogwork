import { RunPlan } from "@cogwork/contracts";
import { Harness } from "@cogwork/engine";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

import { cursorRunner } from "./harness";
import { cursorName, fakeCursorAgent, harnessRunnerLayer, request } from "./harness-fixtures";
import { cursorCatalog } from "./models.generated";

describe("Cursor Harness registry", { timeout: 30_000 }, () => {
  it("serves generated base models and option descriptors", () => {
    const runner = cursorRunner({ name: cursorName, agentBin: `node ${fakeCursorAgent}` });
    const catalog = Harness.make([runner]).catalogs.get(cursorName);

    assert.isNotNull(catalog);
    if (!catalog) return;
    assert.deepStrictEqual(catalog.models, cursorCatalog.models);
    assert.isTrue(catalog.models.some(({ options }) => options?.some(({ id }) => id === "effort")));
    assert.strictEqual(catalog.generatedAgainst, cursorCatalog.generatedAgainst);
    assert.deepStrictEqual(catalog.rawModelIds, cursorCatalog.rawModelIds);
    assert.deepStrictEqual(catalog.rawModelSelections, cursorCatalog.rawModelSelections);
    assert.deepStrictEqual(catalog.provenance, { source: "managed" });
  });

  it.effect("reports outdated and missing native Harnesses", () =>
    Effect.gen(function* () {
      const outdated = cursorRunner({
        name: cursorName,
        agentBin: `node ${fakeCursorAgent} --fake-version=2025.01.01-old`,
      });
      const missing = cursorRunner({ name: cursorName, agentBin: "missing-cursor-agent-149" });

      const outdatedReadiness = yield* outdated.readiness();
      const missingReadiness = yield* missing.readiness();

      assert.strictEqual(outdatedReadiness.compatibility.status, "incompatible");
      assert.strictEqual(outdatedReadiness.compatibility.requirement, ">=2026.08.11");
      assert.isTrue(
        outdatedReadiness.diagnostics.some((diagnostic) =>
          diagnostic.includes("catalog was generated against"),
        ),
      );
      assert.strictEqual(missingReadiness.installation.status, "missing");
    }).pipe(Effect.provide(harnessRunnerLayer)),
  );

  it.effect("rejects stale model and model option selections before launch", () =>
    Effect.gen(function* () {
      const harness = Harness.make([cursorRunner({ name: cursorName, agentBin: `node ${fakeCursorAgent}` })]);
      const staleModel = yield* harness
        .preflight(cursorName, "full", "retired-cursor-model", { effort: "high" })
        .pipe(Effect.flip);
      const staleOption = yield* harness
        .preflight(cursorName, "full", "gpt-5.6-sol", { effort: "extreme" })
        .pipe(Effect.flip);
      const staleComposite = yield* harness
        .preflight(cursorName, "full", "gpt-5.6-luna-high")
        .pipe(Effect.flip);

      assert.strictEqual(staleModel.reason, "stale-selection");
      assert.strictEqual(staleOption.reason, "stale-selection");
      assert.strictEqual(staleComposite.reason, "stale-selection");
    }).pipe(Effect.provide(harnessRunnerLayer)),
  );

  it.effect("rejects a Run Plan without mandatory Sandbox projection", () =>
    Effect.gen(function* () {
      const base = request("/tmp");
      const invalid = {
        ...base,
        plan: new RunPlan({ ...base.plan, middleware: [] }),
      } satisfies Harness.HarnessRequest;
      const runner = cursorRunner({ name: cursorName });

      const error = yield* runner
        .preflight(Harness.HarnessPreflightInput.Launch({ request: invalid }))
        .pipe(Effect.flip);

      assert.strictEqual(error.reason, "sandbox");
    }).pipe(Effect.provide(harnessRunnerLayer)),
  );

  it.effect("rejects a missing checkout before Cursor launch", () =>
    Effect.gen(function* () {
      const invalid = request("/missing-cursor-checkout");
      const runner = cursorRunner({ name: cursorName });

      const error = yield* Harness.make([runner])
        .run(invalid)
        .pipe(
          Stream.runDrain,
          Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
          Effect.flip,
        );

      assert.strictEqual(error.reason, "workspace");
      assert.include(error.message, "/missing-cursor-checkout");
    }).pipe(Effect.provide(harnessRunnerLayer)),
  );

  it.effect("rejects an unreadable checkout before Cursor launch", () =>
    Effect.gen(function* () {
      const invalid = request("/unreadable-cursor-checkout");
      const runner = cursorRunner({ name: cursorName });
      const unreadable = FileSystem.makeNoop({
        stat: () => Effect.succeed({ type: "Directory" } as FileSystem.File.Info),
      });

      const error = yield* Harness.make([runner])
        .run(invalid)
        .pipe(Stream.runDrain, Effect.provideService(FileSystem.FileSystem, unreadable), Effect.flip);

      assert.strictEqual(error.reason, "workspace");
      assert.include(error.message, "cannot read");
    }).pipe(Effect.provide(harnessRunnerLayer)),
  );
});
