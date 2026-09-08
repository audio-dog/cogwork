import { Connection, connectionIdOf } from "@cogwork/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { emptyDraft } from "../features/workspace-record";
import { WorkspaceRecord } from "./workspace-setting-rows";

describe("WorkspaceRecord.SourceControlRows", () => {
  it("offers linear git history for every issue tracker", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceRecord.Provider
        value={{
          state: { draft: { ...emptyDraft, issueTrackerType: "github" }, connections: [] },
          actions: { patch: vi.fn() },
          meta: { disabled: false },
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
            meta: { disabled: false },
          }}
        >
          <WorkspaceRecord.IssueTrackerRows />
        </WorkspaceRecord.Provider>
      </RouterContextProvider>,
    );

    expect(markup).toContain("Establish Connection");
  });
});
