import { beforeEach, describe, expect, it } from "vitest";
import { useRightPanelStore } from "./right-panel";

const reset = () =>
  useRightPanelStore.setState({ open: false, maximized: false, surfaces: [], active: null });

describe("right-panel store", () => {
  beforeEach(reset);

  it("opens the panel and activates a surface when a surface opens", () => {
    useRightPanelStore.getState().openSurface("attention");
    const state = useRightPanelStore.getState();
    expect(state.open).toBe(true);
    expect(state.active).toBe("attention");
    expect(state.surfaces).toEqual(["attention"]);
  });

  it("does not duplicate a surface that is already open", () => {
    const { openSurface } = useRightPanelStore.getState();
    openSurface("attention");
    openSurface("detail");
    openSurface("attention");
    expect(useRightPanelStore.getState().surfaces).toEqual(["attention", "detail"]);
    expect(useRightPanelStore.getState().active).toBe("attention");
  });

  it("falls back to the last remaining surface when the active one closes", () => {
    const { openSurface, closeSurface } = useRightPanelStore.getState();
    openSurface("attention");
    openSurface("detail");
    closeSurface("detail");
    expect(useRightPanelStore.getState().surfaces).toEqual(["attention"]);
    expect(useRightPanelStore.getState().active).toBe("attention");
  });

  it("keeps the active surface when a different one closes", () => {
    const { openSurface, setActive, closeSurface } = useRightPanelStore.getState();
    openSurface("attention");
    openSurface("detail");
    setActive("attention");
    closeSurface("detail");
    expect(useRightPanelStore.getState().active).toBe("attention");
  });

  it("clears the active surface when the last one closes", () => {
    const { openSurface, closeSurface } = useRightPanelStore.getState();
    openSurface("attention");
    closeSurface("attention");
    expect(useRightPanelStore.getState().surfaces).toEqual([]);
    expect(useRightPanelStore.getState().active).toBeNull();
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
    openSurface("activity");
    toggleMaximized();
    closePanel();
    const state = useRightPanelStore.getState();
    expect(state.open).toBe(false);
    expect(state.maximized).toBe(false);
  });
});
