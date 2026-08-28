import { defaultControlStore, WorkspaceId, WorkspaceState } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Workspaces, type WorkspacesValue } from "./workspaces-surface";

const workspaceName = Schema.decodeSync(WorkspaceId)("01991b94-d181-72f9-aae4-6aa1df396e10");
const workspace = Schema.decodeSync(WorkspaceState)({
  _tag: "Registered",
  name: workspaceName,
  displayName: "Cogwork",
  checkoutPath: "/Users/taylor/sites/cogwork",
  issueTracker: "github",
  harness: "codex",
  poll: { status: "ok" },
  contributions: [],
});

const value: WorkspacesValue = {
  state: { status: "ready", workspaces: [workspace], controlStore: defaultControlStore },
  actions: {
    register: vi.fn(),
    rebind: vi.fn(),
    deregister: vi.fn(),
    setLimit: vi.fn(),
  },
  meta: {
    registerPending: false,
    registerError: null,
    registerOutcome: null,
    rebindPending: false,
    rebindError: null,
    rebindOutcome: null,
    rebindTarget: null,
    deregisterPending: false,
    deregisterError: null,
    deregisterTarget: null,
    limitPending: false,
    limitError: null,
  },
};

const render = (nextValue = value) =>
  renderToStaticMarkup(
    <Workspaces.Provider value={nextValue}>
      <Workspaces.Root>
        <Workspaces.Header />
        <Workspaces.Registry />
        <Workspaces.Limits />
      </Workspaces.Root>
    </Workspaces.Provider>,
  );

describe("Workspaces surface", () => {
  it("renders the published workspace and durable limits", () => {
    const markup = render();
    expect(markup).toContain("Cogwork");
    expect(markup).toContain("/Users/taylor/sites/cogwork");
    expect(markup).toContain("Global concurrency");
    expect(markup).toContain(String(defaultControlStore.daemonLimits.globalConcurrency));
  });

  it("explains the deregistration cascade before the action", () => {
    expect(render()).toContain(
      "Deregistering removes the registration, its private settings, and private authoring tree. Run history stays.",
    );
  });

  it("locks every workspace action while its command is in flight", () => {
    const markup = render({
      ...value,
      meta: {
        ...value.meta,
        rebindPending: true,
        rebindTarget: workspaceName,
        deregisterPending: true,
        deregisterTarget: workspaceName,
      },
    });

    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Re-bind path<\/button>/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Deregister<\/button>/);
  });
});
