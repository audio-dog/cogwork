import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveNodeBinary } from "./engine.vite.config.mjs";

describe("resolveNodeBinary", () => {
  it("uses the package bin directory on Unix", () => {
    expect(resolveNodeBinary("/runtime/node", "darwin")).toBe(join("/runtime/node", "bin", "node"));
  });

  it("uses the package root executable on Windows", () => {
    expect(resolveNodeBinary("C:/runtime/node", "win32")).toBe(join("C:/runtime/node", "node.exe"));
  });
});
