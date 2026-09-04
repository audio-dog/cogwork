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
