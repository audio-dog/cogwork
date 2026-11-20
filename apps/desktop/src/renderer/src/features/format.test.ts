import { describe, expect, it } from "vitest";

import { duration, elapsed, relativeTime } from "./format";

describe("duration", () => {
  it("counts seconds, then minutes, then hours", () => {
    expect(duration(0, 9_000)).toBe("0:09");
    expect(duration(0, 69_000)).toBe("1:09");
    expect(duration(0, 3_600_000)).toBe("1:00:00");
    expect(duration(0, 3_669_000)).toBe("1:01:09");
  });

  it("clamps a clock that reads behind the start", () => {
    expect(duration(5_000, 0)).toBe("0:00");
  });
});

describe("elapsed", () => {
  it("stays minute-grained", () => {
    expect(elapsed(0, 30_000)).toBe("<1m");
    expect(elapsed(0, 3_600_000)).toBe("1h");
    expect(elapsed(0, 3_660_000)).toBe("1h 1m");
  });
});

describe("relativeTime", () => {
  it("reads as an age", () => {
    expect(relativeTime(0, 30_000)).toBe("just now");
    expect(relativeTime(0, 120_000)).toBe("2m ago");
    expect(relativeTime(0, 172_800_000)).toBe("2d ago");
  });
});
