import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { primeRootAtoms } from "./atom-registry";
import { harnessCatalogsAtom, harnessReadinessAtom } from "./atoms";

describe("primeRootAtoms", () => {
  it.effect("awaits the blocking atom without awaiting the background atom", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const started: string[] = [];
      const blocking = Atom.make(Effect.succeed("catalogs"));
      const background = Atom.make(
        Effect.sync(() => started.push("readiness")).pipe(Effect.andThen(Effect.never)),
      );

      assert.strictEqual(
        yield* Effect.promise(() => primeRootAtoms(registry, blocking, background)),
        "catalogs",
      );
      assert.deepStrictEqual(started, ["readiness"]);
      assert.isTrue(registry.get(background).waiting);
      assert.isTrue(harnessCatalogsAtom.keepAlive);
      assert.isTrue(harnessReadinessAtom.keepAlive);
      registry.dispose();
    }),
  );
});
