import { join } from "node:path";

export interface EngineCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly terminateTimeoutMillis: number;
}

export interface ResolveEngineCommandInput {
  readonly socketPath: string;
  readonly packaged: boolean;
  readonly baseDir: string;
  readonly drainGraceSeconds?: number;
  readonly nodeBinary?: string;
  readonly engineEntry?: string;
}

const daemonArgs = (socketPath: string, drainGraceSeconds: number): readonly string[] => [
  "daemon",
  "--socket",
  socketPath,
  "--drain-grace",
  String(drainGraceSeconds),
];

const terminateMarginMillis = 5_000;

export const resolveEngineCommand = (input: ResolveEngineCommandInput): EngineCommand => {
  const drainGraceSeconds = input.drainGraceSeconds ?? 5;
  const args = daemonArgs(input.socketPath, drainGraceSeconds);
  const terminateTimeoutMillis = drainGraceSeconds * 1_000 + terminateMarginMillis;

  if (input.packaged) {
    const entry = input.engineEntry ?? join(input.baseDir, "engine", "index.js");
    return {
      command: input.nodeBinary ?? "node",
      args: [entry, ...args],
      cwd: input.baseDir,
      terminateTimeoutMillis,
    };
  }

  const cliDir = join(input.baseDir, "apps", "cli");
  const tsx = join(cliDir, "node_modules", ".bin", "tsx");
  const cliEntry = join(cliDir, "src", "main.ts");
  return { command: tsx, args: [cliEntry, ...args], cwd: cliDir, terminateTimeoutMillis };
};
