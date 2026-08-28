import { type Board, LocalContribution, WorkspaceId, WorkspaceState } from "@cogwork/contracts";
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

const controlStore = {
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
} satisfies NonNullable<Board["controlStore"]>;

const board: Board = {
  items: new Map(),
  runs: new Map(),
  scheduler: null,
  workspaces: new Map([[workspace, registeredWorkspace]]),
  controlStore,
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

  it("keeps workspace contribution instances distinct and deduplicates profile contributions", () => {
    const other = Schema.decodeSync(WorkspaceId)("other");
    const userServer = Schema.decodeSync(LocalContribution)({
      id: "local:user/mcp/review",
      authority: "local:user",
      kind: "mcp-server",
      localName: "review",
      file: "/home/.agents/mcp/review.json",
    });
    const sharedRepoServer = {
      id: "local:repo/mcp/tools",
      authority: "local:repo",
      kind: "mcp-server",
      localName: "tools",
    } satisfies Omit<LocalContribution, "file">;
    const projectedWorkspace = (name: WorkspaceId, checkoutPath: string) =>
      Schema.decodeSync(WorkspaceState)({
        _tag: "Registered",
        name,
        displayName: name,
        checkoutPath,
        issueTracker: "github",
        harness: "codex",
        poll: { status: "ok" },
        contributions: [userServer, { ...sharedRepoServer, file: `${checkoutPath}/tools.json` }],
      });
    const picture = configurationPicture({
      ...board,
      controlStore: {
        ...controlStore,
        contributionSettings: [workspace, other].map((workspaceId) => ({
          contribution: { id: userServer.id, kind: "mcp-server" },
          scope: { _tag: "PrivateWorkspaceOverlay", workspace: workspaceId },
          enabled: true,
        })),
      },
      workspaces: new Map([
        [workspace, projectedWorkspace(workspace, "/repos/example")],
        [other, projectedWorkspace(other, "/repos/other")],
      ]),
    });

    const [projectedUserServer] = picture.contributions.filter(
      (contribution) => contribution.id === userServer.id,
    );
    expect(projectedUserServer).toBeDefined();
    expect(projectedUserServer).not.toHaveProperty("definedIn");
    expect(projectedUserServer?.rows.map((row) => row.scope.workspaceId)).toEqual([workspace, other]);
    expect(
      picture.contributions
        .filter((contribution) => contribution.id === sharedRepoServer.id)
        .map((contribution) => contribution.definedIn),
    ).toEqual([workspace, other]);
  });
});
