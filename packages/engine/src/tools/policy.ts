import {
  defineSandboxPolicy,
  evaluateCommand,
  type PolicyDecision,
  type SandboxPolicy,
} from "@tanstack/ai-sandbox";

import type { OperationPolicyProfile } from "../harness";

export type OwnedToolName = "read" | "write" | "edit" | "bash" | "glob" | "grep" | "webfetch";

// evaluateCommand anchors each pattern (`^…$`) and turns `*` into `.*`, so a
// rule only matches a substring with a leading and trailing `*`, and the single
// space in the `rm` rules is load-bearing: it pins the match to a path boundary
// so a worktree-relative delete (`rm -rf ./build`) stays allowed.
export const hardDenyCommands: ReadonlyArray<string> = [
  "*curl*|*sh*",
  "*wget*|*sh*",
  "*push*-f*main*",
  "*push*-f*master*",
  "*push*main*-f*",
  "*push*master*-f*",
  "*--no-preserve-root*",
  "*rm*-rf /*",
  "*rm*-fr /*",
  "*rm*-rf ~*",
  "*rm*-fr ~*",
  "*rm*-rf*$HOME*",
  "*rm*-fr*$HOME*",
];

export const readOnlyProfile = defineSandboxPolicy({
  commands: { deny: [...hardDenyCommands] },
  capabilities: { fileWrite: "deny", network: "allow" },
  default: "ask",
});

export const fullProfile = defineSandboxPolicy({
  commands: { deny: [...hardDenyCommands] },
  capabilities: { fileWrite: "allow", network: "allow" },
  default: "allow",
});

const profiles: Record<OperationPolicyProfile, SandboxPolicy> = {
  "read-only": readOnlyProfile,
  full: defineSandboxPolicy({
    ...fullProfile,
    commands: { deny: [...hardDenyCommands, "git push*"] },
  }),
};

export const policyForProfile = (profile: OperationPolicyProfile) => profiles[profile];

type Capability = "read" | "fileWrite" | "network" | "command";

const toolCapability: Record<OwnedToolName, Capability> = {
  read: "read",
  glob: "read",
  grep: "read",
  write: "fileWrite",
  edit: "fileWrite",
  webfetch: "network",
  bash: "command",
};

const fallbackDecision = (profile: SandboxPolicy) => profile.default ?? "ask";

export const decideTool = (profile: SandboxPolicy, tool: OwnedToolName, command = ""): PolicyDecision => {
  const capability = toolCapability[tool];
  if (capability === "command") return evaluateCommand(command, profile);
  if (capability === "fileWrite") return profile.capabilities?.fileWrite ?? fallbackDecision(profile);
  if (capability === "network") return profile.capabilities?.network ?? fallbackDecision(profile);
  return "allow";
};

// The AFK keystone: with no human to answer, `ask` collapses to `deny`.
export const compileForAfk = (decision: PolicyDecision) => (decision === "allow" ? "allow" : "deny");

export const gateDecision = (profile: SandboxPolicy, tool: OwnedToolName, command?: string) =>
  compileForAfk(decideTool(profile, tool, command));

export interface PolicyDenied {
  readonly policy: "denied";
  readonly tool: OwnedToolName;
  readonly reason: string;
}

export const policyDenied = (tool: OwnedToolName, reason: string): PolicyDenied => ({
  policy: "denied",
  tool,
  reason,
});

export const isPolicyDenied = (result: unknown): result is PolicyDenied =>
  typeof result === "object" && result !== null && "policy" in result && result.policy === "denied";

const reasonByCapability: Record<Capability, string> = {
  read: "This read-only tool is always available under every policy profile.",
  fileWrite: "This operation's policy profile is read-only, so file writes are denied.",
  network: "Network access is denied by this operation's policy profile.",
  command:
    "This command is denied by policy — it is either not allowed in this operation or it matches a hard-deny rule (force-pushing to main, piping a download into a shell, or recursively deleting an absolute or home path). Take a different approach.",
};

export const denyReason = (tool: OwnedToolName) => reasonByCapability[toolCapability[tool]];
