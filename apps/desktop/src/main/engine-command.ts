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
  // Desktop launch default is true; supervisor retries pass false so a crash does not re-pause scheduling.
  readonly startPaused?: boolean;
}

const daemonArgs = (
  socketPath: string,
  drainGraceSeconds: number,
  startPaused: boolean,
): readonly string[] => {
  const args: string[] = ["daemon", "--socket", socketPath, "--drain-grace", String(drainGraceSeconds)];
  if (startPaused) args.push("--start-paused");
  return args;
};

export const resolveEngineCommand = (input: ResolveEngineCommandInput): EngineCommand => {
  const drainGraceSeconds = input.drainGraceSeconds ?? 5;
  const args = daemonArgs(input.socketPath, drainGraceSeconds, input.startPaused ?? true);

  if (input.packaged) {
    const entry = input.engineEntry ?? join(input.baseDir, "engine", "index.js");
    return { command: input.nodeBinary ?? "node", args: [entry, ...args], cwd: input.baseDir };
  }

  const cliDir = join(input.baseDir, "apps", "cli");
  const tsx = join(cliDir, "node_modules", ".bin", "tsx");
  const cliEntry = join(cliDir, "src", "main.ts");
  return { command: tsx, args: [cliEntry, ...args], cwd: cliDir };
};
