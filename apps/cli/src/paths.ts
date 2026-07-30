import * as os from "node:os";
import * as path from "node:path";

export const defaultSocketPath = path.join(os.tmpdir(), "clanker-forge.sock");

export const defaultConfigHome = path.resolve(import.meta.dirname, "../config");

export const defaultLedgerPath = path.join(os.homedir(), ".clanker-forge", "runs.db");
