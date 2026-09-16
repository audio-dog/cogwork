import { scheduleTask } from "@effect/atom-react";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";

/**
 * One registry shared by the React hooks and the router's loaders. The hooks default to a
 * standalone registry when no provider is present, which would leave a loader priming a
 * different store than the components read.
 */
export const registry = AtomRegistry.make({ scheduleTask });
