import { join } from "node:path";

export interface EngineCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface ResolveEngineCommandInput {
  readonly socketPath: string;
  readonly packaged: boolean;
  readonly baseDir: string;
  readonly drainGraceSeconds?: number;
  readonly nodeBinary?: string;
  readonly engineEntry?: string;
}

const daemonArgs = (socketPath: string, drainGraceSeconds: number) => [
  "daemon",
  "--socket",
  socketPath,
  "--drain-grace",
  String(drainGraceSeconds),
];

const nodeExecutableName = process.platform === "win32" ? "node.exe" : "node";
const defaultDrainGraceSeconds = 5;
const terminateMarginMillis = 5_000;

export const resolveEngineShutdownBudgets = (drainGraceSeconds = defaultDrainGraceSeconds) => ({
  drainGraceSeconds,
  terminateTimeoutMillis: drainGraceSeconds * 1_000 + terminateMarginMillis,
});

export const resolveEngineCommand = (input: ResolveEngineCommandInput) => {
  const drainGraceSeconds = input.drainGraceSeconds ?? defaultDrainGraceSeconds;
  const args = daemonArgs(input.socketPath, drainGraceSeconds);

  if (input.packaged) {
    const entry = input.engineEntry ?? join(input.baseDir, "engine", "index.js");
    const node = input.nodeBinary ?? join(input.baseDir, "engine", "bin", nodeExecutableName);
    return { command: node, args: [entry, ...args], cwd: input.baseDir };
  }

  const cliDir = join(input.baseDir, "apps", "cli");
  const tsx = join(cliDir, "node_modules", ".bin", "tsx");
  const cliEntry = join(cliDir, "src", "main.ts");
  return { command: tsx, args: [cliEntry, ...args], cwd: cliDir };
};
