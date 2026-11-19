import { scheduleTask } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import type * as AsyncResult from "effect/reactivity/AsyncResult";
import type * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";

export const daemonAtomRegistry = AtomRegistry.make({ scheduleTask, defaultIdleTTL: 400 });

export const primeRootAtoms = <Catalogs, CatalogError, Readiness, ReadinessError>(
  registry: AtomRegistry.AtomRegistry,
  catalogs: Atom.Atom<AsyncResult.AsyncResult<Catalogs, CatalogError>>,
  readiness: Atom.Atom<AsyncResult.AsyncResult<Readiness, ReadinessError>>,
) => {
  registry.get(readiness);
  return Effect.runPromise(AtomRegistry.getResult(registry, catalogs));
};
