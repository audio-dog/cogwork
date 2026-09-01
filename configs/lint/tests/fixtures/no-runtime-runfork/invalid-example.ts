import { Runtime } from "effect";

declare const runtime: unknown;

export const fiber = Runtime.runFork(runtime);
