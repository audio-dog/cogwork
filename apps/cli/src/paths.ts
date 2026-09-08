import * as os from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as path from "node:path";

const daemonHome = path.join(os.homedir(), ".cogwork");

export const defaultSocketPath = path.join(daemonHome, "cogwork.sock");

export const defaultControlStorePath = path.join(daemonHome, "control.db");

export const defaultTelemetryStorePath = path.join(daemonHome, "telemetry.db");

export const defaultCredentialsPath = path.join(daemonHome, "credentials.json");
