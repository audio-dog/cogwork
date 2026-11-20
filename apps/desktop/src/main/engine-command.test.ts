import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type EngineCommand, resolveEngineCommand, resolveEngineShutdownBudgets } from "./engine-command";

const socketPath = "/home/me/.cogwork/cogwork.sock";
const drainGraceSeconds = (command: EngineCommand) =>
  Number(command.args[command.args.indexOf("--drain-grace") + 1]);

describe("resolveEngineCommand", () => {
  it("allows daemon drain to finish before supervisor termination", () => {
    const budgets = resolveEngineShutdownBudgets();

    expect(budgets.terminateTimeoutMillis).toBeGreaterThan(budgets.drainGraceSeconds * 1_000);
  });

  it("starts development diagnostics before the CLI's tsx loader", () => {
    const baseDir = "/repo";
    const cliDir = join(baseDir, "apps", "cli");
    const command = resolveEngineCommand({ socketPath, packaged: false, baseDir });

    expect(command.command).toBe("node");
    expect(command.args).toEqual([
      "--report-on-fatalerror",
      "--diagnostic-dir=/home/me/.cogwork",
      "--heapsnapshot-near-heap-limit=3",
      join(cliDir, "node_modules", "tsx", "dist", "cli.mjs"),
      join(cliDir, "src", "main.ts"),
      "daemon",
      "--socket",
      socketPath,
      "--drain-grace",
      "5",
    ]);
    expect(command.cwd).toBe(cliDir);
  });

  it("runs a bundled engine entry with node when packaged", () => {
    const baseDir = "/Applications/cogwork.app/Contents/Resources";
    const command = resolveEngineCommand({ socketPath, packaged: true, baseDir });

    expect(command.command).toBe("node");
    expect(command.args).toContain(join(baseDir, "engine", "index.js"));
    expect(command.args).toContain(socketPath);
  });

  it("honors node binary and engine entry overrides when packaged", () => {
    const command = resolveEngineCommand({
      socketPath,
      packaged: true,
      baseDir: "/res",
      nodeBinary: "/opt/node/bin/node",
      engineEntry: "/opt/engine/main.js",
    });

    expect(command.command).toBe("/opt/node/bin/node");
    expect(command.args).toContain("/opt/engine/main.js");
  });

  it("does not pass the retired scheduling mode flag", () => {
    const command = resolveEngineCommand({ socketPath, packaged: true, baseDir: "/res" });

    expect(command.args).not.toContain("--start-paused");
  });

  it("passes a custom drain grace through to the daemon", () => {
    const command = resolveEngineCommand({
      socketPath,
      packaged: false,
      baseDir: "/repo",
      drainGraceSeconds: 30,
    });

    expect(drainGraceSeconds(command)).toBe(30);
    expect(resolveEngineShutdownBudgets(30).terminateTimeoutMillis).toBe(35_000);
  });

  it("passes the configured performance evidence workspace", () => {
    const command = resolveEngineCommand({
      socketPath,
      packaged: true,
      baseDir: "/res",
      performanceWorkspace: "cogwork",
    });

    expect(command.args).toContain("--performance-workspace");
    expect(command.args).toContain("cogwork");
  });

  it("keeps continuous profiling off by default", () => {
    const command = resolveEngineCommand({ socketPath, packaged: false, baseDir: "/repo" });

    expect(command.args).not.toContain("--cpu-prof");
    expect(command.args).not.toContain("--heap-prof");
  });

  it("enables continuous profiles in the diagnostics directory", () => {
    const command = resolveEngineCommand({
      socketPath,
      packaged: false,
      baseDir: "/repo",
      profiling: true,
    });

    expect(command.args.slice(0, 5)).toEqual([
      "--report-on-fatalerror",
      "--diagnostic-dir=/home/me/.cogwork",
      "--heapsnapshot-near-heap-limit=3",
      "--cpu-prof",
      "--heap-prof",
    ]);
  });
});
