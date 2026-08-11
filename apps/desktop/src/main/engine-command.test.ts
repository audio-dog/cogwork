import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveEngineCommand } from "./engine-command";

const socketPath = "/home/me/.clanker-forge/clanker-forge.sock";

describe("resolveEngineCommand", () => {
  it("runs the CLI daemon through the CLI's own tsx in development", () => {
    const baseDir = "/repo";
    const cliDir = join(baseDir, "apps", "cli");
    const command = resolveEngineCommand({ socketPath, packaged: false, baseDir });

    expect(command.command).toBe(join(cliDir, "node_modules", ".bin", "tsx"));
    expect(command.args).toEqual([
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
    const baseDir = "/Applications/clanker-forge.app/Contents/Resources";
    const command = resolveEngineCommand({ socketPath, packaged: true, baseDir });

    expect(command.command).toBe("node");
    expect(command.args[0]).toBe(join(baseDir, "engine", "index.js"));
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
    expect(command.args[0]).toBe("/opt/engine/main.js");
  });

  it("passes a custom drain grace through to the daemon", () => {
    const command = resolveEngineCommand({
      socketPath,
      packaged: false,
      baseDir: "/repo",
      drainGraceSeconds: 30,
    });

    const graceIndex = command.args.indexOf("--drain-grace");
    expect(command.args[graceIndex + 1]).toBe("30");
  });
});
