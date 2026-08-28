import { type Board, WorkspaceId, WorkspaceState } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { configurationPicture } from "./configuration-picture";

const workspace = Schema.decodeSync(WorkspaceId)("example");
const registeredWorkspace = Schema.decodeSync(WorkspaceState)({
  _tag: "Registered",
  name: workspace,
  displayName: "Example",
  checkoutPath: "/repos/example",
  issueTracker: "github",
  harness: "codex",
  poll: { status: "ok" },
  contributions: [
    {
      id: "local:repo/mcp/tools",
      authority: "local:repo",
      kind: "mcp-server",
      localName: "tools",
      file: "/repos/example/.agents/mcp/tools.json",
    },
    {
      id: "local:private/skill/review",
      authority: "local:private",
      kind: "skill",
      localName: "review",
      file: "/home/.cogwork/workspaces/example/skills/review/SKILL.md",
    },
  ],
});

const board: Board = {
  items: new Map(),
  runs: new Map(),
  scheduler: null,
  workspaces: new Map([[workspace, registeredWorkspace]]),
  controlStore: {
    daemonLimits: {
      globalConcurrency: 4,
      perWorkspaceConcurrency: 4,
      dailyBudget: 50,
      revision: 0,
    },
    contributionSettings: [
      {
        contribution: { id: "local:repo/mcp/tools", kind: "mcp-server" },
        scope: { _tag: "PrivateWorkspaceOverlay", workspace },
        enabled: true,
      },
    ],
    operationSettings: [],
  },
};

describe("configurationPicture", () => {
  it("projects registered workspace contributions and their raw setting rows", () => {
    const picture = configurationPicture(board);

    expect(picture.workspaces).toEqual([{ id: workspace, name: "Example", checkoutPath: "/repos/example" }]);
    expect(picture.plugins).toEqual([]);
    expect(picture.contributions).toEqual([
      {
        id: "local:repo/mcp/tools",
        authority: { _tag: "local", tree: "repo" },
        kind: "mcp-server",
        localName: "tools",
        summary: "/repos/example/.agents/mcp/tools.json",
        file: "/repos/example/.agents/mcp/tools.json",
        definedAt: "workspace-input",
        definedIn: workspace,
        load: { _tag: "loaded" },
        rows: [
          {
            scope: { kind: "private-overlay", workspaceId: workspace },
            value: true,
            source: "Control store",
          },
        ],
      },
      {
        id: "local:private/skill/review",
        authority: { _tag: "local", tree: "private" },
        kind: "skill",
        localName: "review",
        summary: "/home/.cogwork/workspaces/example/skills/review/SKILL.md",
        file: "/home/.cogwork/workspaces/example/skills/review/SKILL.md",
        definedAt: "private-overlay",
        definedIn: workspace,
        load: { _tag: "loaded" },
        rows: [],
      },
    ]);
  });
});
