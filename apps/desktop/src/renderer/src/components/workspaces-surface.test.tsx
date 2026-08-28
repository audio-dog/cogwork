import { defaultControlStore, WorkspaceState } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Workspaces, type WorkspacesValue } from "./workspaces-surface";

const workspace = Schema.decodeSync(WorkspaceState)({
  _tag: "Registered",
  name: "01991b94-d181-72f9-aae4-6aa1df396e10",
  displayName: "Cogwork",
  checkoutPath: "/Users/taylor/sites/cogwork",
  issueTracker: "github",
  harness: "codex",
  poll: { status: "ok" },
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

const render = () =>
  renderToStaticMarkup(
    <Workspaces.Provider value={value}>
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
});
