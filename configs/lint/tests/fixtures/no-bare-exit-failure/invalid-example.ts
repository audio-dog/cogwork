import { assert } from "@effect/vitest";
import * as Exit from "effect/Exit";

declare const exit: Exit.Exit<number, Error>;

assert.isTrue(Exit.isFailure(exit));
