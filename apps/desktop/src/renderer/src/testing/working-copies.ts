import type { WorkflowRecord } from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import { layer as workingCopiesLayer } from "../features/working-copy";
import { type ListWorkflowOptions, makeWorkingCopiesClient } from "../features/working-copy-provider";
import { MemoryDaemon, type MemoryDaemonProbe, memoryDaemonLayer } from "./working-copy-daemon";

const listNothing: ListWorkflowOptions = () => Effect.succeed([]);

export const openTestWorkingCopies = async (
  records: ReadonlyArray<WorkflowRecord>,
  listOptions: ListWorkflowOptions = listNothing,
) => {
  const runtime = ManagedRuntime.make(
    workingCopiesLayer.pipe(Layer.provideMerge(memoryDaemonLayer(records))),
  );
  const daemon = <A, E>(use: (probe: MemoryDaemonProbe) => Effect.Effect<A, E>) =>
    runtime.runPromise(Effect.flatMap(MemoryDaemon, use));
  const client = await runtime.runPromise(
    makeWorkingCopiesClient(listOptions).pipe(Scope.provide(runtime.scope)),
  );
  return { client, daemon, dispose: () => runtime.dispose() };
};
