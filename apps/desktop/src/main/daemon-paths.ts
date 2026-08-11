import { homedir } from "node:os";
import { join } from "node:path";

export const defaultSocketPath = join(homedir(), ".clanker-forge", "clanker-forge.sock");
