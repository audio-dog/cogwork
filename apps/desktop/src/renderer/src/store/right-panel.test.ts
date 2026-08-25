import { RunId, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { type Surface, surfaceId, useRightPanelStore } from "./right-panel";

const workspace = Schema.decodeSync(WorkspaceId);
const workItem = Schema.decodeSync(WorkItemId);
const runId = Schema.decodeSync(RunId);

const item = (ws: string, id: string, run?: string): Surface => ({
  kind: "item",
  workspace: workspace(ws),
  workItem: workItem(id),
  ...(run ? { runId: runId(run) } : {}),
});

const reset = () =>
  useRightPanelStore.setState({
    open: false,
    maximized: false,
    surfaces: [],
    active: null,
  });

describe("right-panel store", () => {
  beforeEach(reset);

  it("starts closed with no surfaces", () => {
    const state = useRightPanelStore.getState();
    expect(state.open).toBe(false);
    expect(state.surfaces).toEqual([]);
    expect(state.active).toBeNull();
  });

  it("identifies an item tab by its workspace and work item", () => {
    expect(surfaceId(item("acme", "#50"))).toBe("item:acme:#50");
    expect(surfaceId(item("beta", "#50"))).not.toBe(surfaceId(item("acme", "#50")));
    expect(surfaceId({ kind: "attention" })).toBe("attention");
    expect(surfaceId({ kind: "activity" })).toBe("activity");
    expect(surfaceId({ kind: "terminal" })).toBe("terminal");
  });

  it("focuses an existing Tool surface instead of adding it twice", () => {
    const { openSurface, setActive } = useRightPanelStore.getState();
    openSurface({ kind: "attention" });
    openSurface({ kind: "activity" });
    setActive("activity");
    openSurface({ kind: "attention" });

    const state = useRightPanelStore.getState();
    expect(state.surfaces).toEqual([{ kind: "attention" }, { kind: "activity" }]);
    expect(state.active).toBe("attention");
  });

  it("closes a Tool surface and clears active when it was the last tab", () => {
    const { openSurface, closeSurface } = useRightPanelStore.getState();
    openSurface({ kind: "terminal" });
    closeSurface("terminal");

    const state = useRightPanelStore.getState();
    expect(state.surfaces).toEqual([]);
    expect(state.active).toBeNull();
  });

  it("opens the panel and focuses an item tab when the item opens", () => {
    useRightPanelStore.getState().openSurface(item("acme", "#50"));
    const state = useRightPanelStore.getState();
    expect(state.open).toBe(true);
    expect(state.active).toBe("item:acme:#50");
    expect(state.surfaces).toEqual([item("acme", "#50")]);
  });

  it("focuses the existing tab on a second open of the same item", () => {
    const { openSurface, setActive } = useRightPanelStore.getState();
    openSurface(item("acme", "#50"));
    openSurface(item("acme", "#51"));
    setActive("item:acme:#51");
    openSurface(item("acme", "#50"));
    const state = useRightPanelStore.getState();
    expect(state.surfaces).toEqual([item("acme", "#50"), item("acme", "#51")]);
    expect(state.active).toBe("item:acme:#50");
  });

  it("keeps a selected run when the item opens again", () => {
    const { openSurface } = useRightPanelStore.getState();
    const historicalRun = item("acme", "#50", "run-1");
    openSurface(historicalRun);
    openSurface(item("acme", "#50"));

    expect(useRightPanelStore.getState().surfaces).toEqual([historicalRun]);
  });

  it("tells apart the same work item id in different workspaces", () => {
    const { openSurface } = useRightPanelStore.getState();
    openSurface(item("acme", "#50"));
    openSurface(item("beta", "#50"));
    const state = useRightPanelStore.getState();
    expect(state.surfaces).toEqual([item("acme", "#50"), item("beta", "#50")]);
    expect(state.active).toBe("item:beta:#50");
  });

  it("keeps item tabs open until they are closed", () => {
    const { openSurface, setActive, closeSurface } = useRightPanelStore.getState();
    openSurface(item("acme", "#50"));
    openSurface({ kind: "attention" });
    setActive("attention");
    expect(useRightPanelStore.getState().surfaces).toContainEqual(item("acme", "#50"));
    closeSurface("item:acme:#50");
    expect(useRightPanelStore.getState().surfaces).toEqual([{ kind: "attention" }]);
  });

  it("falls back to the last remaining tab when the active item closes", () => {
    const { openSurface, closeSurface } = useRightPanelStore.getState();
    openSurface(item("acme", "#50"));
    openSurface(item("acme", "#51"));
    closeSurface("item:acme:#51");
    const state = useRightPanelStore.getState();
    expect(state.surfaces).toEqual([item("acme", "#50")]);
    expect(state.active).toBe("item:acme:#50");
  });

  it("keeps the active tab when a different item closes", () => {
    const { openSurface, setActive, closeSurface } = useRightPanelStore.getState();
    openSurface(item("acme", "#50"));
    openSurface(item("acme", "#51"));
    setActive("item:acme:#50");
    closeSurface("item:acme:#51");
    expect(useRightPanelStore.getState().active).toBe("item:acme:#50");
  });

  it("toggling the panel clears the maximized state", () => {
    const { toggleMaximized, togglePanel } = useRightPanelStore.getState();
    toggleMaximized();
    expect(useRightPanelStore.getState().maximized).toBe(true);
    togglePanel();
    const state = useRightPanelStore.getState();
    expect(state.open).toBe(true);
    expect(state.maximized).toBe(false);
  });

  it("closing the panel resets open and maximized", () => {
    const { openSurface, toggleMaximized, closePanel } = useRightPanelStore.getState();
    openSurface(item("acme", "#50"));
    toggleMaximized();
    closePanel();
    const state = useRightPanelStore.getState();
    expect(state.open).toBe(false);
    expect(state.maximized).toBe(false);
  });
});
