import { dirname, join } from "node:path";

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
  readonly profiling?: boolean;
}

const daemonArgs = (socketPath: string, drainGraceSeconds: number): readonly string[] => [
  "daemon",
  "--socket",
  socketPath,
  "--drain-grace",
  String(drainGraceSeconds),
];

const diagnosticArgs = (directory: string, profiling: boolean): readonly string[] => [
  "--report-on-fatalerror",
  `--diagnostic-dir=${directory}`,
  "--heapsnapshot-near-heap-limit=3",
  ...(profiling ? ["--cpu-prof", "--heap-prof"] : []),
];
const defaultDrainGraceSeconds = 5;
const terminateMarginMillis = 5_000;

export const resolveEngineShutdownBudgets = (drainGraceSeconds = defaultDrainGraceSeconds) => ({
  drainGraceSeconds,
  terminateTimeoutMillis: drainGraceSeconds * 1_000 + terminateMarginMillis,
});

export const resolveEngineCommand = (input: ResolveEngineCommandInput): EngineCommand => {
  const drainGraceSeconds = input.drainGraceSeconds ?? defaultDrainGraceSeconds;
  const args = daemonArgs(input.socketPath, drainGraceSeconds);
  const diagnostics = diagnosticArgs(dirname(input.socketPath), input.profiling ?? false);

  if (input.packaged) {
    const entry = input.engineEntry ?? join(input.baseDir, "engine", "index.js");
    return {
      command: input.nodeBinary ?? "node",
      args: [...diagnostics, entry, ...args],
      cwd: input.baseDir,
    };
  }

  const cliDir = join(input.baseDir, "apps", "cli");
  const tsx = join(cliDir, "node_modules", ".bin", "tsx");
  const cliEntry = join(cliDir, "src", "main.ts");
  return { command: tsx, args: [...diagnostics, cliEntry, ...args], cwd: cliDir };
};
