// PROTOTYPE FIXTURE — placeholder data for the Plugins / Customize / workspace surfaces.
//
// Nothing here comes from the daemon. It is a single scenario chosen to put every state the
// surfaces must render on screen at once: all four Scopes, all six contribution kinds, the three
// Authorities, every conflict class, a failed load, an offer that is not an enablement, a staged
// update, a stale catalog, a deprecated entry, a withdrawn entry, an unsatisfiable need, an
// Engine refusal, and two workspaces that share one git remote.
//
// Replace with the real picture when the surfaces are wired to `@cogwork/contracts`.

import type {
  CatalogEntry,
  ConfigurationPicture,
  Contribution,
  InstalledPlugin,
  Operation,
  Workflow,
  Workspace,
  WorkspaceId,
} from "./configuration-model";

const id = (value: string) => value as WorkspaceId;

export const cogworkWorkspaceId = id("ws_01H8Z3");
export const reviewWorkspaceId = id("ws_01H8Z9");
export const clankerWorkspaceId = id("ws_01H9A2");

/**
 * `cogwork` and `cogwork (review)` are two workspaces over one remote — the case ADR 0013's
 * hint-not-identity rule makes possible, and the case a surface that labels a workspace by its
 * remote alone cannot render.
 */
const workspaces: readonly Workspace[] = [
  {
    id: cogworkWorkspaceId,
    name: "cogwork",
    checkoutPath: "~/sites/cogwork",
    remote: "colonylabs/cogwork",
    tracker: "GitHub Issues",
  },
  {
    id: reviewWorkspaceId,
    name: "cogwork (review)",
    checkoutPath: "~/sites/cogwork-review",
    remote: "colonylabs/cogwork",
    tracker: "GitHub Issues",
  },
  {
    id: clankerWorkspaceId,
    name: "clanker-forge",
    checkoutPath: "~/sites/clanker-forge",
    remote: "taylorfsteele/clanker-forge",
    tracker: "Linear",
  },
];

const contributions: readonly Contribution[] = [
  {
    id: "plugin:linear/mcp/linear",
    kind: "mcp-server",
    localName: "linear",
    authority: { _tag: "plugin", pluginId: "linear" },
    summary: "Reads and writes Linear issues, projects, and cycles.",
    file: "~/.cogwork/plugins/linear@1.4.0/mcp/linear.json",
    definedAt: "runtime-host",
    load: { _tag: "loaded" },
    readiness: { _tag: "ready" },
    rows: [{ scope: { kind: "runtime-host" }, value: true, source: "Control store" }],
  },
  {
    id: "plugin:linear/command/linear-triage",
    kind: "command",
    localName: "linear-triage",
    authority: { _tag: "plugin", pluginId: "linear" },
    summary: "Prompts for a triage pass over one Linear issue.",
    file: "~/.cogwork/plugins/linear@1.4.0/commands/linear-triage.md",
    definedAt: "runtime-host",
    load: { _tag: "loaded" },
    rows: [{ scope: { kind: "runtime-host" }, value: true, source: "Control store" }],
  },

  {
    id: "plugin:gh-review/skill/pr-summary",
    kind: "skill",
    localName: "pr-summary",
    authority: { _tag: "plugin", pluginId: "gh-review" },
    summary: "Summarizes a pull request's checks, reviews, and divergence.",
    file: "~/.cogwork/plugins/gh-review@2.1.0/skills/pr-summary/SKILL.md",
    definedAt: "runtime-host",
    load: { _tag: "loaded" },
    // On at the profile, off in this workspace's overlay. The overlay is the highest Scope, so it
    // wins whole — and turning it off here is what leaves `follow-up` unable to run.
    rows: [
      { scope: { kind: "runtime-host" }, value: true, source: "Control store" },
      {
        scope: { kind: "private-overlay", workspaceId: cogworkWorkspaceId },
        value: false,
        source: "Control store",
      },
    ],
  },
  {
    id: "plugin:gh-review/rules/review-style",
    kind: "rules",
    localName: "review-style",
    authority: { _tag: "plugin", pluginId: "gh-review" },
    summary: "Advisory review conventions, scoped by glob to `src/**`.",
    file: "~/.cogwork/plugins/gh-review@2.1.0/rules/review-style.md",
    definedAt: "runtime-host",
    load: { _tag: "loaded" },
    rows: [
      {
        scope: { kind: "workspace-input", workspaceId: cogworkWorkspaceId },
        value: true,
        source: ".cogwork/settings.json",
      },
    ],
  },
  {
    id: "plugin:gh-review/subagent/reviewer",
    kind: "subagent",
    localName: "reviewer",
    authority: { _tag: "plugin", pluginId: "gh-review" },
    summary: "Delegated reviewer for a single diff.",
    file: "~/.cogwork/plugins/gh-review@2.1.0/subagents/reviewer.md",
    definedAt: "runtime-host",
    load: { _tag: "loaded" },
    // Nothing written at any Scope. Not off — not there.
    rows: [],
  },

  {
    id: "plugin:granola/mcp/granola",
    kind: "mcp-server",
    localName: "granola",
    authority: { _tag: "plugin", pluginId: "granola" },
    summary: "Reads meeting notes so a ticket can be drafted from them.",
    file: "~/dev/granola-plugin/mcp/granola.json",
    definedAt: "runtime-host",
    // A malformed pointed-at file yields no contribution, so the setting written for it dangles.
    load: {
      _tag: "failed",
      reason: "mcp/granola.json:14 — expected a string for `command`, found an array.",
    },
    rows: [
      {
        scope: { kind: "private-overlay", workspaceId: cogworkWorkspaceId },
        value: true,
        source: "Control store",
        diagnostic: {
          _tag: "dangling",
          detail:
            "This setting references a contribution that no longer exists. The value was dropped; clear it or fix the file it points at.",
          source: "Control store",
        },
      },
    ],
  },

  {
    id: "plugin:codex-extras/command/codex-login",
    kind: "command",
    localName: "codex-login",
    authority: { _tag: "plugin", pluginId: "codex-extras" },
    summary: "Walks the host-owned Codex CLI login.",
    file: "~/.cogwork/plugins/codex-extras@0.9.3/commands/codex-login.md",
    definedAt: "runtime-host",
    load: { _tag: "loaded" },
    rows: [{ scope: { kind: "runtime-host" }, value: true, source: "Control store" }],
  },

  {
    id: "engine/subagent/triager",
    kind: "subagent",
    localName: "triager",
    authority: { _tag: "engine" },
    summary: "First-party triage subagent shipped with the Engine.",
    file: "engine://subagents/triager",
    definedAt: "runtime-host",
    load: { _tag: "loaded" },
    rows: [{ scope: { kind: "runtime-host" }, value: true, source: "Control store" }],
  },
  {
    id: "engine/rules/house-style",
    kind: "rules",
    localName: "house-style",
    authority: { _tag: "engine" },
    summary: "Always-apply guidance the Engine contributes to every Run.",
    file: "engine://rules/house-style",
    definedAt: "runtime-host",
    load: { _tag: "loaded" },
    rows: [{ scope: { kind: "runtime-host" }, value: true, source: "Control store" }],
  },

  {
    // Same local name as `plugin:linear/mcp/linear`, and a different contribution. Identity
    // carries Authority, so the set composes by union and cogwork never reconciles the two.
    id: "local/mcp/linear",
    kind: "mcp-server",
    localName: "linear",
    authority: { _tag: "local" },
    summary: "A hand-configured Linear server, added before the Plugin existed.",
    file: "~/.cogwork/mcp/linear.json",
    definedAt: "runtime-host",
    load: { _tag: "loaded" },
    readiness: {
      _tag: "not-ready",
      reason: "The configured command exited before the MCP handshake completed.",
    },
    rows: [
      {
        scope: { kind: "private-overlay", workspaceId: cogworkWorkspaceId },
        value: true,
        source: "Control store",
      },
    ],
  },
  {
    // A repository may ship an executable contribution but may never enable one, so this one's
    // switch writes to the private overlay instead. The `enabled: true` someone committed for it is
    // inadmissible: dropped with a diagnostic naming the file, never silently ignored.
    id: "local/mcp/repo-tools",
    kind: "mcp-server",
    localName: "repo-tools",
    authority: { _tag: "local" },
    summary: "Repository-specific tools, configured in the repo for anyone who clones it.",
    file: ".cogwork/mcp/repo-tools.json",
    definedAt: "workspace-input",
    definedIn: cogworkWorkspaceId,
    load: { _tag: "loaded" },
    readiness: { _tag: "ready" },
    rows: [
      {
        scope: { kind: "workspace-input", workspaceId: cogworkWorkspaceId },
        value: true,
        source: ".cogwork/settings.json",
        diagnostic: {
          _tag: "inadmissible",
          detail:
            "An MCP server's on / off may not be written here. The value was dropped; the file may still ship the server.",
          source: ".cogwork/settings.json",
        },
      },
    ],
  },
  {
    id: "local/skill/release-notes",
    kind: "skill",
    localName: "release-notes",
    authority: { _tag: "local" },
    summary: "Turns a merged range into release notes.",
    file: ".cogwork/skills/release-notes/SKILL.md",
    definedAt: "workspace-input",
    definedIn: cogworkWorkspaceId,
    load: { _tag: "loaded" },
    rows: [
      {
        scope: { kind: "workspace-input", workspaceId: cogworkWorkspaceId },
        value: true,
        source: ".cogwork/settings.json",
      },
    ],
  },
  {
    // Defined in the overlay: a file you keep beside the workspace and never commit.
    id: "local/skill/scratch-notes",
    kind: "skill",
    localName: "scratch-notes",
    authority: { _tag: "local" },
    summary: "Your own scratch conventions for this checkout.",
    file: "~/.cogwork/overlays/ws_01H8Z3/skills/scratch-notes/SKILL.md",
    definedAt: "private-overlay",
    definedIn: cogworkWorkspaceId,
    load: { _tag: "loaded" },
    rows: [
      {
        scope: { kind: "private-overlay", workspaceId: cogworkWorkspaceId },
        value: true,
        source: "Control store",
      },
    ],
  },
  {
    // A second workspace with something of its own, so the menu is not one populated repo.
    id: "local/rules/forge-style",
    kind: "rules",
    localName: "forge-style",
    authority: { _tag: "local" },
    summary: "Coding conventions committed to the clanker-forge repository.",
    file: ".cogwork/rules/forge-style.md",
    definedAt: "workspace-input",
    definedIn: clankerWorkspaceId,
    load: { _tag: "loaded" },
    rows: [
      {
        scope: { kind: "workspace-input", workspaceId: clankerWorkspaceId },
        value: true,
        source: ".cogwork/settings.json",
      },
    ],
  },
  {
    id: "local/command/ship",
    kind: "command",
    localName: "ship",
    authority: { _tag: "local" },
    summary: "Prompts for a release checklist.",
    file: ".cogwork/settings.json",
    definedAt: "workspace-input",
    definedIn: clankerWorkspaceId,
    load: { _tag: "loaded" },
    rows: [
      {
        scope: { kind: "workspace-input", workspaceId: clankerWorkspaceId },
        value: true,
        source: ".cogwork/settings.json",
        diagnostic: {
          _tag: "ambiguous",
          detail:
            "Two entries in this file claim `local/command/ship`. Picking a winner would be arbitrary, so the file is in error until one is removed.",
          source: ".cogwork/settings.json",
        },
      },
    ],
  },
];

const plugins: readonly InstalledPlugin[] = [
  {
    record: {
      pluginId: "linear",
      source: { _tag: "catalog", entryId: "linear" },
      resolvedIdentity: "linear@1.4.0",
      principal: "taylor",
      revision: 7,
      installedAt: "2026-06-02T09:12:00Z",
    },
    name: "Linear",
    summary: "Track work in Linear and let cogwork read and write its issues.",
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
      source: { _tag: "catalog", entryId: "gh-review" },
      resolvedIdentity: "gh-review@2.1.0",
      principal: "taylor",
      revision: 3,
      installedAt: "2026-05-18T14:41:00Z",
    },
    name: "GitHub review pack",
    summary: "Review conventions, a pull-request summary Skill, and a pre-push Hook.",
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
      source: { _tag: "local-path", path: "~/dev/granola-plugin" },
      // No declared version, so the bundle is identified by content revision.
      resolvedIdentity: "granola@rev:9f21c4e",
      principal: "taylor",
      revision: 1,
      installedAt: "2026-08-21T11:03:00Z",
    },
    name: "Granola notes",
    summary: "Draft a ticket from a meeting note.",
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
      source: { _tag: "catalog", entryId: "codex-extras" },
      resolvedIdentity: "codex-extras@0.9.3",
      principal: "taylor",
      revision: 2,
      installedAt: "2026-04-07T08:20:00Z",
    },
    name: "Codex harness extras",
    summary: "Notifications and a login walk-through for the host-owned Codex CLI.",
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

/** The first-party Plugins cogwork ships. A document in the app, not a fetched index. */
const catalog: readonly CatalogEntry[] = [
  {
    id: "linear",
    name: "Linear",
    summary: "Track work in Linear and let cogwork read and write its issues.",
    contributes: ["mcp-server", "command"],
  },
  {
    id: "gh-review",
    name: "GitHub review pack",
    summary: "Review conventions, a pull-request summary Skill, and a reviewer Subagent.",
    contributes: ["skill", "rules", "subagent"],
  },
  {
    id: "codex-extras",
    name: "Codex harness extras",
    summary: "A login walk-through for the host-owned Codex CLI.",
    contributes: ["command"],
  },
  {
    id: "granola",
    name: "Granola notes",
    summary: "Draft a ticket from a meeting note.",
    contributes: ["mcp-server"],
  },
  {
    id: "notion",
    name: "Notion",
    summary: "Read Notion pages and databases as Work Context.",
    contributes: ["mcp-server"],
  },
  {
    id: "slack",
    name: "Slack",
    summary: "Post a Run's outcome into a channel.",
    contributes: ["mcp-server"],
  },
];

const operations: readonly Operation[] = [
  {
    id: "triage",
    name: "Triage",
    summary: "Classify an observed item and propose the one correct next state.",
    needs: [
      {
        id: "tracker-read",
        label: "Read the issue tracker",
        kind: "mcp-server",
        boundContributionId: "plugin:linear/mcp/linear",
        satisfied: true,
      },
    ],
    locked: [],
    rows: [
      {
        key: "enabled",
        level: "default",
        scope: { kind: "runtime-host" },
        value: "on",
        source: "Control store",
      },
      {
        key: "harness",
        level: "default",
        scope: { kind: "runtime-host" },
        value: "claude-code",
        source: "Control store",
      },
      {
        key: "model",
        level: "default",
        scope: { kind: "runtime-host" },
        value: "claude-sonnet-5",
        source: "Control store",
      },
      {
        key: "effort",
        level: "default",
        scope: { kind: "runtime-host" },
        value: "medium",
        source: "Control store",
      },
      {
        key: "binding",
        level: "operation",
        scope: { kind: "runtime-host" },
        value: "tracker-read → plugin:linear/mcp/linear",
        source: "Control store",
      },
    ],
  },
  {
    id: "implement",
    name: "Implement",
    summary: "Take a ready ticket to a pull request.",
    needs: [
      {
        id: "tracker-read",
        label: "Read the issue tracker",
        kind: "mcp-server",
        boundContributionId: "plugin:linear/mcp/linear",
        satisfied: true,
      },
      {
        id: "repo-write",
        label: "Write to the worktree",
        kind: "subagent",
        boundContributionId: "engine/subagent/triager",
        satisfied: true,
      },
    ],
    // The Definition's lock *is* Engine policy. It constrains and names its source; it never
    // overwrites, because a silent override is indistinguishable from never having set the value.
    locked: ["permission-profile"],
    rows: [
      {
        key: "enabled",
        level: "default",
        scope: { kind: "runtime-host" },
        value: "on",
        source: "Control store",
      },
      {
        key: "harness",
        level: "default",
        scope: { kind: "runtime-host" },
        value: "claude-code",
        source: "Control store",
      },
      // A default at the profile, and an Operation-level value in the overlay. The Operation level
      // wins *before* Scope is consulted.
      {
        key: "model",
        level: "default",
        scope: { kind: "runtime-host" },
        value: "claude-sonnet-5",
        source: "Control store",
      },
      {
        key: "model",
        level: "operation",
        scope: { kind: "private-overlay", workspaceId: cogworkWorkspaceId },
        value: "claude-opus-5",
        source: "Control store",
      },
      {
        key: "effort",
        level: "workflow",
        scope: { kind: "runtime-host" },
        value: "high",
        source: "Control store",
      },
      {
        key: "permission-profile",
        level: "operation",
        scope: { kind: "private-overlay", workspaceId: cogworkWorkspaceId },
        value: "unrestricted",
        source: "Control store",
        refusedBy: "the Implement Operation Definition, which locks permission-profile",
      },
    ],
  },
  {
    id: "follow-up",
    name: "Follow up",
    summary: "Move a bot-authored pull request forward after failing checks or review comments.",
    needs: [
      {
        id: "pr-summary",
        label: "Summarize the pull request",
        kind: "skill",
        boundContributionId: "plugin:gh-review/skill/pr-summary",
        // Bound, but the bound contribution resolves to off in this workspace's overlay. On / off
        // is the entry gate, so a binding cannot reach past it.
        satisfied: false,
        reason:
          "`plugin:gh-review/skill/pr-summary` is bound to this need but is off at the Private workspace overlay. On / off is the entry gate, so the Run Plan is rejected before dispatch.",
      },
    ],
    locked: [],
    rows: [
      {
        key: "enabled",
        level: "default",
        scope: { kind: "runtime-host" },
        value: "on",
        source: "Control store",
      },
      {
        key: "harness",
        level: "default",
        scope: { kind: "runtime-host" },
        value: "claude-code",
        source: "Control store",
      },
      {
        key: "model",
        level: "default",
        scope: { kind: "runtime-host" },
        value: "claude-sonnet-5",
        source: "Control store",
      },
    ],
  },
  {
    id: "verify",
    name: "Verify",
    summary: "Check a merged change against what the ticket asked for.",
    needs: [
      {
        id: "test-runner",
        label: "Run the test suite",
        kind: "mcp-server",
        satisfied: false,
        reason: "No contribution is bound to this need. Every declared need is required.",
      },
    ],
    locked: [],
    rows: [
      {
        key: "enabled",
        level: "default",
        scope: { kind: "runtime-host" },
        value: "off",
        source: "Control store",
      },
    ],
  },
];

const workflows: readonly Workflow[] = [
  {
    id: "backlog",
    name: "Backlog to merge",
    summary: "Triage an item, implement it, then follow its pull request up.",
    operationIds: ["triage", "implement", "follow-up"],
  },
  {
    id: "verification",
    name: "Verification",
    summary: "Check merged work against its ticket.",
    operationIds: ["verify"],
  },
];

export const placeholderConfiguration: ConfigurationPicture = {
  principal: "taylor",
  hostId: "host_01H7QK",
  workspaces,
  plugins,
  contributions,
  catalog,
  workflows,
  operations,
  limits: { globalConcurrency: 4, perWorkspaceConcurrency: 2, dailyBudget: 40 },
  controlStore: {
    schemaVersion: 6,
    openedAt: "2026-08-25T08:02:00Z",
    preMigrationCopy: { at: "2026-08-19T17:44:00Z", fromVersion: 5 },
  },
};

export function contributionById(id: string): Contribution | undefined {
  return placeholderConfiguration.contributions.find((contribution) => contribution.id === id);
}
