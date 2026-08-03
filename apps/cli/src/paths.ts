import * as os from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as path from "node:path";

export const defaultSocketPath = path.join(os.tmpdir(), "clanker-forge.sock");

export const defaultConfigHome = path.resolve(import.meta.dirname, "../config");

const daemonHome = path.join(os.homedir(), ".clanker-forge");

export const defaultLedgerPath = path.join(daemonHome, "runs.db");

export const defaultCredentialsPath = path.join(daemonHome, "credentials.json");
