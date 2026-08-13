import * as os from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as path from "node:path";

const daemonHome = path.join(os.homedir(), ".cogwork");

export const defaultSocketPath = path.join(daemonHome, "cogwork.sock");

export const defaultConfigHome = path.resolve(import.meta.dirname, "../config");

export const defaultLedgerPath = path.join(daemonHome, "runs.db");

export const defaultCredentialsPath = path.join(daemonHome, "credentials.json");
