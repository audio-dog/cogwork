import { expect, it } from "vitest";

import { kibibytesToBytes, ratePerSecond } from "./process-health";

it("calculates monotonic rates and ignores counter resets", () => {
  expect(ratePerSecond(10, 30, 2_000)).toBe(10);
  expect(ratePerSecond(30, 5, 2_000)).toBe(0);
  expect(ratePerSecond(10, 30, 0)).toBe(0);
});

it("converts Electron memory units to bytes", () => {
  expect(kibibytesToBytes(2)).toBe(2_048);
});
