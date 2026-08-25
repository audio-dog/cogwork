import { RunId, WorkItemId, WorkspaceId } from "@cogwork/contracts";
import { Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { useRightPanelStore } from "./right-panel";

const workspace = Schema.decodeSync(WorkspaceId);
const workItem = Schema.decodeSync(WorkItemId);
const runId = Schema.decodeSync(RunId);

const item = (ws: string, id: string, run?: string) =>
  expect.objectContaining({
    kind: "item" as const,
    workspace: workspace(ws),
    workItem: workItem(id),
    ...(run ? { runId: runId(run) } : {}),
  });

const surfaceIdAt = (index: number) => {
  const surface = useRightPanelStore.getState().surfaces[index];
  if (!surface) throw new Error(`Missing surface at index ${index}`);
  return surface.id;
};

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

  it("focuses an existing Tool surface instead of adding it twice", () => {
    const { openTool, setActive } = useRightPanelStore.getState();
    openTool("attention");
    openTool("activity");
    setActive("activity");
    openTool("attention");

    const state = useRightPanelStore.getState();
    expect(state.surfaces.map((surface) => surface.id)).toEqual(["attention", "activity"]);
    expect(state.active).toBe("attention");
  });

  it("closes a Tool surface and clears active when it was the last tab", () => {
    const { openTool, closeSurface } = useRightPanelStore.getState();
    openTool("terminal");
    closeSurface("terminal");

    const state = useRightPanelStore.getState();
    expect(state.surfaces).toEqual([]);
    expect(state.active).toBeNull();
  });

  it("opens the panel and focuses an item tab when the item opens", () => {
    useRightPanelStore.getState().openItem(workspace("acme"), workItem("#50"));
    const state = useRightPanelStore.getState();
    expect(state.open).toBe(true);
    expect(state.active).toBe(surfaceIdAt(0));
    expect(state.surfaces).toEqual([item("acme", "#50")]);
  });

  it("focuses the existing tab on a second open of the same item", () => {
    const { openItem, setActive } = useRightPanelStore.getState();
    openItem(workspace("acme"), workItem("#50"));
    openItem(workspace("acme"), workItem("#51"));
    setActive(surfaceIdAt(1));
    openItem(workspace("acme"), workItem("#50"));
    const state = useRightPanelStore.getState();
    expect(state.surfaces).toEqual([item("acme", "#50"), item("acme", "#51")]);
    expect(state.active).toBe(surfaceIdAt(0));
  });

  it("open resets a run pin", () => {
    const { openItem } = useRightPanelStore.getState();
    openItem(workspace("acme"), workItem("#50"), runId("run-1"));
    openItem(workspace("acme"), workItem("#50"));

    expect(useRightPanelStore.getState().surfaces).toEqual([item("acme", "#50")]);
  });

  it("focus preserves a run pin", () => {
    const { openItem, openTool, setActive } = useRightPanelStore.getState();
    openItem(workspace("acme"), workItem("#50"), runId("run-1"));
    openTool("attention");
    setActive(surfaceIdAt(0));

    expect(useRightPanelStore.getState().surfaces).toContainEqual(item("acme", "#50", "run-1"));
    expect(useRightPanelStore.getState().surfaces.map((surface) => surface.id)).toEqual([
      surfaceIdAt(0),
      "attention",
    ]);
  });

  it("tells apart the same work item id in different workspaces", () => {
    const { openItem } = useRightPanelStore.getState();
    openItem(workspace("acme"), workItem("#50"));
    openItem(workspace("beta"), workItem("#50"));
    const state = useRightPanelStore.getState();
    expect(state.surfaces).toEqual([item("acme", "#50"), item("beta", "#50")]);
    expect(state.active).toBe(surfaceIdAt(1));
  });

  it("keeps item tabs open until they are closed", () => {
    const { openItem, openTool, setActive, closeSurface } = useRightPanelStore.getState();
    openItem(workspace("acme"), workItem("#50"));
    openTool("attention");
    setActive("attention");
    expect(useRightPanelStore.getState().surfaces).toContainEqual(item("acme", "#50"));
    closeSurface(surfaceIdAt(0));
    expect(useRightPanelStore.getState().surfaces.map((surface) => surface.id)).toEqual(["attention"]);
  });

  it("falls back to the last remaining tab when the active item closes", () => {
    const { openItem, closeSurface } = useRightPanelStore.getState();
    openItem(workspace("acme"), workItem("#50"));
    openItem(workspace("acme"), workItem("#51"));
    closeSurface(surfaceIdAt(1));
    const state = useRightPanelStore.getState();
    expect(state.surfaces).toEqual([item("acme", "#50")]);
    expect(state.active).toBe(surfaceIdAt(0));
  });

  it("keeps the active tab when a different item closes", () => {
    const { openItem, setActive, closeSurface } = useRightPanelStore.getState();
    openItem(workspace("acme"), workItem("#50"));
    openItem(workspace("acme"), workItem("#51"));
    const firstId = surfaceIdAt(0);
    setActive(firstId);
    closeSurface(surfaceIdAt(1));
    expect(useRightPanelStore.getState().active).toBe(firstId);
  });

  it("keeps only the selected tab when closing other tabs", () => {
    const { closeOtherSurfaces, openItem, openTool } = useRightPanelStore.getState();
    openTool("attention");
    openTool("activity");
    openItem(workspace("acme"), workItem("#50"));
    closeOtherSurfaces("activity");

    const state = useRightPanelStore.getState();
    expect(state.surfaces.map((surface) => surface.id)).toEqual(["activity"]);
    expect(state.active).toBe("activity");
  });

  it("empties the panel without closing it when closing all tabs", () => {
    const { closeAllSurfaces, openItem, openTool } = useRightPanelStore.getState();
    openTool("attention");
    openItem(workspace("acme"), workItem("#50"));
    closeAllSurfaces();

    const state = useRightPanelStore.getState();
    expect(state.open).toBe(true);
    expect(state.surfaces).toEqual([]);
    expect(state.active).toBeNull();
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
    const { openItem, toggleMaximized, togglePanel } = useRightPanelStore.getState();
    openItem(workspace("acme"), workItem("#50"));
    toggleMaximized();
    togglePanel();
    const state = useRightPanelStore.getState();
    expect(state.open).toBe(false);
    expect(state.maximized).toBe(false);
  });
});
