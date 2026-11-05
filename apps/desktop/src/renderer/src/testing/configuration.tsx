import type { ReactNode } from "react";
import { Configuration } from "../components/configuration-provider";
import {
  Authority,
  type ConfigurationPicture,
  type Contribution,
  Diagnostic,
  type InstalledPlugin,
  LoadState,
  McpReadiness,
  type Workspace,
  type WorkspaceId,
} from "../features/configuration-model";

const id = (value: string) => value as WorkspaceId;

export const cogworkWorkspaceId = id("ws_01H8Z3");
const reviewWorkspaceId = id("ws_01H8Z9");
export const clankerWorkspaceId = id("ws_01H9A2");

const workspaces: readonly Workspace[] = [
  {
    id: cogworkWorkspaceId,
    name: "cogwork",
    checkoutPath: "~/sites/cogwork",
    remote: "colonylabs/cogwork",
  },
  {
    id: reviewWorkspaceId,
    name: "cogwork (review)",
    checkoutPath: "~/sites/cogwork-review",
    remote: "colonylabs/cogwork",
  },
  {
    id: clankerWorkspaceId,
    name: "clanker-forge",
    checkoutPath: "~/sites/clanker-forge",
    remote: "taylorfsteele/clanker-forge",
  },
];

const contributions: readonly Contribution[] = [
  {
    id: "plugin:linear/mcp/linear",
    kind: "mcp-server",
    localName: "linear",
    authority: Authority.plugin({ pluginId: "linear" }),
    summary: "Reads and writes Linear issues, projects, and cycles.",
    file: "~/.cogwork/plugins/linear@1.4.0/mcp/linear.json",
    definedAt: "settings-profile",
    load: LoadState.loaded({}),
    readiness: McpReadiness.ready({}),
    rows: [
      { scope: { kind: "settings-profile" }, value: true, source: "Control store" },
      {
        scope: { kind: "private-overlay", workspaceId: cogworkWorkspaceId },
        value: false,
        source: "Control store",
      },
    ],
  },
  {
    id: "plugin:linear/command/linear-triage",
    kind: "command",
    localName: "linear-triage",
    authority: Authority.plugin({ pluginId: "linear" }),
    summary: "Prompts for a triage pass over one Linear issue.",
    file: "~/.cogwork/plugins/linear@1.4.0/commands/linear-triage.md",
    definedAt: "settings-profile",
    load: LoadState.loaded({}),
    rows: [],
  },

  {
    id: "plugin:gh-review/skill/pr-summary",
    kind: "skill",
    localName: "pr-summary",
    authority: Authority.plugin({ pluginId: "gh-review" }),
    summary: "Summarizes a pull request's checks, reviews, and divergence.",
    file: "~/.cogwork/plugins/gh-review@2.1.0/skills/pr-summary/SKILL.md",
    definedAt: "settings-profile",
    load: LoadState.loaded({}),
    rows: [],
  },
  {
    id: "plugin:gh-review/rules/review-style",
    kind: "rules",
    localName: "review-style",
    authority: Authority.plugin({ pluginId: "gh-review" }),
    summary: "Advisory review conventions, scoped by glob to `src/**`.",
    file: "~/.cogwork/plugins/gh-review@2.1.0/rules/review-style.md",
    definedAt: "settings-profile",
    load: LoadState.loaded({}),
    rows: [],
  },
  {
    id: "plugin:gh-review/subagent/reviewer",
    kind: "subagent",
    localName: "reviewer",
    authority: Authority.plugin({ pluginId: "gh-review" }),
    summary: "Delegated reviewer for a single diff.",
    file: "~/.cogwork/plugins/gh-review@2.1.0/agents/reviewer.md",
    definedAt: "settings-profile",
    load: LoadState.loaded({}),
    rows: [],
  },

  {
    id: "plugin:granola/mcp/granola",
    kind: "mcp-server",
    localName: "granola",
    authority: Authority.plugin({ pluginId: "granola" }),
    summary: "Reads meeting notes so a ticket can be drafted from them.",
    file: "~/.cogwork/plugins/granola@0.4.2/mcp/granola.json",
    definedAt: "settings-profile",
    load: LoadState.failed({
      reason: "mcp/granola.json:14 — expected a string for `command`, found an array.",
    }),
    rows: [
      {
        scope: { kind: "private-overlay", workspaceId: cogworkWorkspaceId },
        value: true,
        source: "Control store",
        diagnostic: Diagnostic.dangling({
          detail:
            "This setting references a contribution that no longer exists. The value was dropped; clear it or fix the file it points at.",
          source: "Control store",
        }),
      },
    ],
  },

  {
    id: "plugin:codex-extras/command/codex-login",
    kind: "command",
    localName: "codex-login",
    authority: Authority.plugin({ pluginId: "codex-extras" }),
    summary: "Walks the host-owned Codex CLI login.",
    file: "~/.cogwork/plugins/codex-extras@0.9.3/commands/codex-login.md",
    definedAt: "settings-profile",
    load: LoadState.loaded({}),
    rows: [],
  },

  {
    id: "engine/subagent/triager",
    kind: "subagent",
    localName: "triager",
    authority: Authority.engine({}),
    summary: "First-party triage subagent shipped with the Engine.",
    file: "engine://agents/triager",
    definedAt: "settings-profile",
    load: LoadState.loaded({}),
    rows: [],
  },
  {
    id: "engine/rules/house-style",
    kind: "rules",
    localName: "house-style",
    authority: Authority.engine({}),
    summary: "Always-apply guidance the Engine contributes to every Run.",
    file: "engine://rules/house-style",
    definedAt: "settings-profile",
    load: LoadState.loaded({}),
    rows: [],
  },

  {
    id: "local:user/skill/commit-style",
    kind: "skill",
    localName: "commit-style",
    authority: Authority.local({ tree: "user" }),
    summary: "How you like commit messages written.",
    file: "~/.agents/skills/commit-style/SKILL.md",
    definedAt: "settings-profile",
    load: LoadState.loaded({}),
    rows: [],
  },
  {
    id: "local:user/command/scratch",
    kind: "command",
    localName: "scratch",
    authority: Authority.local({ tree: "user" }),
    summary: "Opens a scratch prompt you keep on this machine.",
    file: "~/.agents/commands/scratch.md",
    definedAt: "settings-profile",
    load: LoadState.loaded({}),
    rows: [],
  },
  {
    id: "local:private/mcp/linear",
    kind: "mcp-server",
    localName: "linear",
    authority: Authority.local({ tree: "private" }),
    summary: "A hand-configured Linear server, added before the Plugin existed.",
    file: "~/.cogwork/workspaces/ws_01H8Z3/mcp/linear.json",
    definedAt: "private-overlay",
    definedIn: cogworkWorkspaceId,
    load: LoadState.loaded({}),
    readiness: McpReadiness["not-ready"]({
      reason: "The configured command exited before the MCP handshake completed.",
    }),
    rows: [
      {
        scope: { kind: "private-overlay", workspaceId: cogworkWorkspaceId },
        value: true,
        source: "Control store",
      },
    ],
  },
  {
    id: "local:repo/mcp/repo-tools",
    kind: "mcp-server",
    localName: "repo-tools",
    authority: Authority.local({ tree: "repo" }),
    summary: "Repository-specific tools, configured in the repo for anyone who clones it.",
    file: ".agents/mcp/repo-tools.json",
    definedAt: "workspace-input",
    definedIn: cogworkWorkspaceId,
    load: LoadState.loaded({}),
    readiness: McpReadiness.ready({}),
    rows: [
      {
        scope: { kind: "workspace-input", workspaceId: cogworkWorkspaceId },
        value: true,
        source: ".cogwork/settings.json",
        diagnostic: Diagnostic.inadmissible({
          detail:
            "An MCP server's on / off may not be written here. The value was dropped; the file may still ship the server.",
          source: ".cogwork/settings.json",
        }),
      },
    ],
  },
  {
    id: "local:repo/skill/release-notes",
    kind: "skill",
    localName: "release-notes",
    authority: Authority.local({ tree: "repo" }),
    summary: "Turns a merged range into release notes.",
    file: ".agents/skills/release-notes/SKILL.md",
    definedAt: "workspace-input",
    definedIn: cogworkWorkspaceId,
    load: LoadState.loaded({}),
    rows: [],
  },
  {
    id: "local:private/skill/scratch-notes",
    kind: "skill",
    localName: "scratch-notes",
    authority: Authority.local({ tree: "private" }),
    summary: "Your own scratch conventions for this checkout.",
    file: "~/.cogwork/workspaces/ws_01H8Z3/skills/scratch-notes/SKILL.md",
    definedAt: "private-overlay",
    definedIn: cogworkWorkspaceId,
    load: LoadState.loaded({}),
    rows: [],
  },
  {
    id: "local:repo/rules/forge-style",
    kind: "rules",
    localName: "forge-style",
    authority: Authority.local({ tree: "repo" }),
    summary: "Coding conventions committed to the clanker-forge repository.",
    file: ".agents/rules/forge-style.md",
    definedAt: "workspace-input",
    definedIn: clankerWorkspaceId,
    load: LoadState.loaded({}),
    rows: [],
  },
  {
    id: "local:repo/command/ship",
    kind: "command",
    localName: "ship",
    authority: Authority.local({ tree: "repo" }),
    summary: "Prompts for a release checklist.",
    file: ".agents/commands/ship.md",
    definedAt: "workspace-input",
    definedIn: clankerWorkspaceId,
    load: LoadState.loaded({}),
    rows: [],
  },
];

const plugins: readonly InstalledPlugin[] = [
  {
    record: {
      pluginId: "linear",
      resolvedIdentity: "linear@1.4.0",
      principal: "taylor",
      installedAt: "2026-06-02T09:12:00Z",
    },
    name: "Linear",
    summary: "Track work in Linear and let cogwork read and write its issues.",
    manifestFailure: null,
    contributionIds: ["plugin:linear/mcp/linear", "plugin:linear/command/linear-triage"],
    permissions: [
      { label: "Non-interactive turn", detail: "Enforced. The turn cannot prompt.", fidelity: "exact" },
      {
        label: "Worktree confinement",
        detail: "Enforced. Writes are confined to the Run's worktree.",
        fidelity: "exact",
      },
      {
        label: "Operation read / write posture",
        detail: "Enforced. This Plugin's contributions inherit the Operation's posture.",
        fidelity: "exact",
      },
      {
        label: "Network reach",
        detail: "Recorded as coarse: any host. The Harness cannot enforce a host list.",
        fidelity: "coarse",
      },
    ],
    requiredConnections: ["linear"],
    setup: [
      { id: "connect", label: "Connect Linear", detail: "Authenticate the Linear Connection.", done: true },
      {
        id: "team",
        label: "Choose the default team",
        detail: "Which team's issues cogwork observes by default.",
        done: false,
      },
    ],
  },
  {
    record: {
      pluginId: "gh-review",
      resolvedIdentity: "gh-review@2.1.0",
      principal: "taylor",
      installedAt: "2026-05-18T14:41:00Z",
    },
    name: "GitHub review pack",
    summary: "Review conventions, a pull-request summary Skill, and a pre-push Hook.",
    manifestFailure: null,
    contributionIds: [
      "plugin:gh-review/skill/pr-summary",
      "plugin:gh-review/rules/review-style",
      "plugin:gh-review/subagent/reviewer",
    ],
    permissions: [
      { label: "Non-interactive turn", detail: "Enforced. The turn cannot prompt.", fidelity: "exact" },
      {
        label: "Worktree confinement",
        detail: "Enforced. Writes are confined to the Run's worktree.",
        fidelity: "exact",
      },
      {
        label: "Operation read / write posture",
        detail: "Enforced. This Plugin's contributions inherit the Operation's posture.",
        fidelity: "exact",
      },
      {
        label: "Hook commands",
        detail:
          "Recorded as coarse: this bundle ships the script its Hook invokes, so nothing reaches the command itself.",
        fidelity: "coarse",
      },
    ],
    requiredConnections: [],
    setup: [],
  },
  {
    record: {
      pluginId: "granola",
      resolvedIdentity: "granola@0.4.2",
      principal: "taylor",
      installedAt: "2026-08-21T11:03:00Z",
    },
    name: "Granola notes",
    summary: "Draft a ticket from a meeting note.",
    manifestFailure: null,
    contributionIds: ["plugin:granola/mcp/granola"],
    permissions: [
      { label: "Non-interactive turn", detail: "Enforced. The turn cannot prompt.", fidelity: "exact" },
      {
        label: "Worktree confinement",
        detail: "Enforced. Writes are confined to the Run's worktree.",
        fidelity: "exact",
      },
      {
        label: "Operation read / write posture",
        detail: "Enforced. This Plugin's contributions inherit the Operation's posture.",
        fidelity: "exact",
      },
    ],
    requiredConnections: ["granola"],
    setup: [
      {
        id: "connect",
        label: "Connect Granola",
        detail: "Authenticate the Granola Connection.",
        done: false,
      },
    ],
  },
  {
    record: {
      pluginId: "codex-extras",
      resolvedIdentity: "codex-extras@0.9.3",
      principal: "taylor",
      installedAt: "2026-04-07T08:20:00Z",
    },
    name: "Codex harness extras",
    summary: "Notifications and a login walk-through for the host-owned Codex CLI.",
    manifestFailure: null,
    contributionIds: ["plugin:codex-extras/command/codex-login"],
    permissions: [
      { label: "Non-interactive turn", detail: "Enforced. The turn cannot prompt.", fidelity: "exact" },
      {
        label: "Worktree confinement",
        detail: "Enforced. Writes are confined to the Run's worktree.",
        fidelity: "exact",
      },
      {
        label: "Operation read / write posture",
        detail: "Enforced. This Plugin's contributions inherit the Operation's posture.",
        fidelity: "exact",
      },
      {
        label: "Built-in tools",
        detail: "Recorded as coarse: the Harness reports a tool set, not a per-tool decision.",
        fidelity: "coarse",
      },
    ],
    requiredConnections: [],
    setup: [],
  },
];

export const placeholderConfiguration: ConfigurationPicture = {
  workspaces,
  plugins,
  catalogPlugins: [],
  contributions,
};

export function workspaceById(workspaceId?: WorkspaceId) {
  return placeholderConfiguration.workspaces.find((workspace) => workspace.id === workspaceId);
}

export function contributionById(id: string): Contribution | undefined {
  return placeholderConfiguration.contributions.find((contribution) => contribution.id === id);
}

export function StaticConfigurationProvider({
  picture,
  children,
}: {
  picture: ConfigurationPicture;
  children: ReactNode;
}) {
  return <Configuration.Provider picture={picture}>{children}</Configuration.Provider>;
}
