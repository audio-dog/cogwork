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

// The desktop launch default: the engine starts on, but scheduling holds paused until the person
// presses the header toggle, so a laptop launch never silently spends budget.
const daemonArgs = (socketPath: string, drainGraceSeconds: number): readonly string[] => [
  "daemon",
  "--socket",
  socketPath,
  "--drain-grace",
  String(drainGraceSeconds),
  "--start-paused",
];

export const resolveEngineCommand = (input: ResolveEngineCommandInput): EngineCommand => {
  const drainGraceSeconds = input.drainGraceSeconds ?? 5;
  const args = daemonArgs(input.socketPath, drainGraceSeconds);

  if (input.packaged) {
    const entry = input.engineEntry ?? join(input.baseDir, "engine", "index.js");
    return { command: input.nodeBinary ?? "node", args: [entry, ...args], cwd: input.baseDir };
  }

  const cliDir = join(input.baseDir, "apps", "cli");
  const tsx = join(cliDir, "node_modules", ".bin", "tsx");
  const cliEntry = join(cliDir, "src", "main.ts");
  return { command: tsx, args: [cliEntry, ...args], cwd: cliDir };
};
