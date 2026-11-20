import { useSidebar } from "@cogwork/ui/components/sidebar";
import type { CSSProperties } from "react";
import { createContext, use, useRef } from "react";

import { clampResizableWidth, useResizableWidth } from "../hooks/use-resizable-width";

export const RIGHT_PANEL_STORAGE_KEY = "cf.rightPanelWidth";
export const RIGHT_PANEL_DEFAULT_WIDTH = 30 * 16;
export const RIGHT_PANEL_MIN_WIDTH = 22 * 16;
// Keep the main column usable no matter how wide the panel is dragged.
const MAIN_CONTENT_MIN_WIDTH = 30 * 16;

function storedPanelBounds(sidebarWidth: number, sidebarExpanded: boolean) {
  return {
    minWidth: RIGHT_PANEL_MIN_WIDTH,
    mainContentMinWidth: MAIN_CONTENT_MIN_WIDTH,
    reservedWidth: sidebarExpanded ? sidebarWidth : 0,
  };
}

function insetWidth(wrapper: HTMLElement): number {
  const inset = wrapper.querySelector<HTMLElement>("[data-slot='sidebar-inset']");
  return inset?.getBoundingClientRect().width ?? window.innerWidth;
}

const RIGHT_PANEL_CLAMP = {
  minWidth: RIGHT_PANEL_MIN_WIDTH,
  mainContentMinWidth: MAIN_CONTENT_MIN_WIDTH,
};

const RIGHT_PANEL_WIDTH_HOST = "right-panel-width-host";

function rightPanelWidthHost(wrapper: HTMLElement): HTMLElement | null {
  return wrapper.querySelector<HTMLElement>(`[data-slot='${RIGHT_PANEL_WIDTH_HOST}']`);
}

function readRightPanelWidth(wrapper: HTMLElement): number {
  const host = rightPanelWidthHost(wrapper);
  if (host) {
    const inline = Number.parseFloat(host.style.getPropertyValue("--right-panel-width"));
    if (!Number.isNaN(inline) && inline > 0) return inline;
    const computed = Number.parseFloat(getComputedStyle(host).getPropertyValue("--right-panel-width"));
    if (!Number.isNaN(computed) && computed > 0) return computed;
  }
  const region = wrapper.querySelector<HTMLElement>("[data-slot='right-panel-region']");
  return region?.getBoundingClientRect().width ?? RIGHT_PANEL_DEFAULT_WIDTH;
}

function setRightPanelWidth(wrapper: HTMLElement, width: number): void {
  rightPanelWidthHost(wrapper)?.style.setProperty("--right-panel-width", `${width}px`);
}

function rightPanelIsOpen(wrapper: HTMLElement): boolean {
  const region = wrapper.querySelector<HTMLElement>("[data-slot='right-panel-region']");
  return (region?.getBoundingClientRect().width ?? 0) > 0;
}

export function reservedOpenRightPanelWidth(wrapper: HTMLElement): number {
  if (!rightPanelIsOpen(wrapper)) return 0;
  return readRightPanelWidth(wrapper);
}

// While the left sidebar drag eats inset width, shrink an open right panel so the
// flex main column keeps its minimum instead of absorbing all of the squeeze.
export function reclampOpenRightPanelWidth(wrapper: HTMLElement): void {
  if (!rightPanelIsOpen(wrapper)) return;
  const clamped = clampResizableWidth(readRightPanelWidth(wrapper), insetWidth(wrapper), RIGHT_PANEL_CLAMP);
  setRightPanelWidth(wrapper, clamped);
}

export function rightPanelRegionElement(wrapper: HTMLElement): HTMLElement | null {
  return wrapper.querySelector<HTMLElement>("[data-slot='right-panel-region']");
}

interface RightPanelWidthActions {
  setWidth: (width: number) => void;
  reset: () => void;
}

export const RightPanelWidthContext = createContext<RightPanelWidthActions | null>(null);

export function useRightPanelWidthActions(): RightPanelWidthActions {
  const actions = use(RightPanelWidthContext);
  if (!actions) throw new Error("Right panel width actions must render inside RightPanelWidthProvider");
  return actions;
}

function useStoredRightPanelWidth(sidebarWidth: number, sidebarExpanded: boolean) {
  return useResizableWidth({
    storageKey: RIGHT_PANEL_STORAGE_KEY,
    defaultWidth: RIGHT_PANEL_DEFAULT_WIDTH,
    ...storedPanelBounds(sidebarWidth, sidebarExpanded),
  });
}

// Lives inside SidebarProvider so it can read collapsed state for clamp bounds.
// Inherits --right-panel-width to descendants via a contents wrapper so __root__'s
// sidebar-only style prop never stomps the persisted value on re-render.
export function RightPanelWidthProvider({
  sidebarWidth,
  children,
}: {
  sidebarWidth: number;
  children: React.ReactNode;
}) {
  const { state } = useSidebar();
  const expanded = state === "expanded";
  const rightPanel = useStoredRightPanelWidth(sidebarWidth, expanded);
  const panelStyle = {
    "--right-panel-width": `${rightPanel.width}px`,
  } as CSSProperties;

  return (
    <RightPanelWidthContext value={{ setWidth: rightPanel.setWidth, reset: rightPanel.reset }}>
      <div data-slot={RIGHT_PANEL_WIDTH_HOST} className="contents" style={panelStyle}>
        {children}
      </div>
    </RightPanelWidthContext>
  );
}

interface DragState {
  startX: number;
  startWidth: number;
  width: number;
  wrapper: HTMLElement;
  region: HTMLElement | null;
}

export function RightPanelResizeHandle({
  onCommit,
  onReset,
}: {
  onCommit: (width: number) => void;
  onReset: () => void;
}) {
  const dragRef = useRef<DragState | null>(null);

  const beginDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const handle = event.currentTarget;
    const wrapper = handle.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
    if (!wrapper) return;
    const region = wrapper.querySelector<HTMLElement>("[data-slot='right-panel-region']");
    const startWidth = region?.getBoundingClientRect().width ?? RIGHT_PANEL_DEFAULT_WIDTH;
    // Suppress the width transition so the drag tracks the cursor 1:1.
    region?.style.setProperty("transition-duration", "0ms");

    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    dragRef.current = {
      startX: event.clientX,
      startWidth,
      width: startWidth,
      wrapper,
      region,
    };
  };

  const updateDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    event.preventDefault();
    // Dragging the left edge leftward widens the panel. Clamp against the inset
    // width so an expanded left sidebar is accounted for.
    drag.width = clampResizableWidth(
      drag.startWidth - (event.clientX - drag.startX),
      insetWidth(drag.wrapper),
      RIGHT_PANEL_CLAMP,
    );
    setRightPanelWidth(drag.wrapper, drag.width);
  };

  const endDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.region?.style.removeProperty("transition-duration");
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    onCommit(drag.width);
  };

  return (
    <button
      type="button"
      aria-label="Resize side panel"
      title="Drag to resize · double-click to reset"
      tabIndex={-1}
      onPointerDown={beginDrag}
      onPointerMove={updateDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      className="relative z-30 w-1 shrink-0 cursor-col-resize touch-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent hover:after:bg-sidebar-border"
    />
  );
}
