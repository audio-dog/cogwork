import { assert } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";

declare const exit: Exit.Exit<number, Error>;

assert.isTrue(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
assert.include(Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "succeeded", "timed out");
