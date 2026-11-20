import { Connection, connectionIdOf, GitHubIssueFieldId } from "@cogwork/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { emptyDraft } from "../features/workspace-record";
import { priorityFieldItems, WorkspaceRecord } from "./workspace-setting-rows";

describe("WorkspaceRecord.SourceControlRows", () => {
  it("offers linear git history for every issue tracker", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceRecord.Provider
        value={{
          state: { draft: { ...emptyDraft, issueTrackerType: "github" }, connections: [] },
          actions: { patch: vi.fn() },
          meta: { disabled: false, workspace: null },
        }}
      >
        <WorkspaceRecord.SourceControlRows />
      </WorkspaceRecord.Provider>,
    );

    expect(markup).toContain("Linear history");
    expect(markup).toContain('aria-label="Require linear history"');
  });
});

describe("WorkspaceRecord.IssueTrackerRows", () => {
  it("offers Connection setup when the visible binding is revoked", () => {
    const revoked = Connection.make({
      id: connectionIdOf("linear", "revoked"),
      system: "linear",
      account: "revoked",
      status: "revoked",
    });
    const router = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const markup = renderToStaticMarkup(
      <RouterContextProvider router={router}>
        <WorkspaceRecord.Provider
          value={{
            state: {
              draft: {
                ...emptyDraft,
                issueTrackerType: "linear",
                issueTrackerConnectionId: revoked.id,
              },
              connections: [revoked],
            },
            actions: { patch: vi.fn() },
            meta: { disabled: false, workspace: null },
          }}
        >
          <WorkspaceRecord.IssueTrackerRows />
        </WorkspaceRecord.Provider>
      </RouterContextProvider>,
    );

    expect(markup).toContain("Establish Connection");
  });

  it("uses a picker for GitHub priority and never asks for typed coordinates", () => {
    const router = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const markup = renderToStaticMarkup(
      <RouterContextProvider router={router}>
        <WorkspaceRecord.Provider
          value={{
            state: { draft: emptyDraft, connections: [] },
            actions: { patch: vi.fn() },
            meta: { disabled: false, workspace: null },
          }}
        >
          <WorkspaceRecord.IssueTrackerRows />
        </WorkspaceRecord.Provider>
      </RouterContextProvider>,
    );

    expect(markup).toContain('aria-label="Priority issue field"');
    expect(markup).not.toContain("Priority project number");
  });

  it("keeps a selected field visible when GitHub no longer returns it", () => {
    const field = { id: Schema.decodeSync(GitHubIssueFieldId)(42), name: "Priority" };
    expect(priorityFieldItems([field], "99")).toEqual([
      { value: "none", label: "Do not order by priority" },
      { value: "99", label: "Unavailable field #99" },
      { value: "42", label: "Priority" },
    ]);
  });
});
