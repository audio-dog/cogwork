import { useSidebar } from "@cogwork/ui/components/sidebar";
import { useLocalStorageValue, useWindowSize } from "@react-hookz/web";
import { useRef } from "react";

import { clampResizableWidth } from "../hooks/use-resizable-width";
import { useRightPanelStore } from "../store/right-panel";
import {
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_STORAGE_KEY,
  reclampOpenRightPanelWidth,
  reservedOpenRightPanelWidth,
  rightPanelRegionElement,
} from "./right-panel-resize";

const STORAGE_KEY = "cf.sidebarWidth";
const DEFAULT_WIDTH = 16 * 16;
// Intentionally narrower than the brand needs: below the sidebar header's
// container-query threshold (15.75rem, see nav-sidebar) the brand hides itself,
// so the sidebar can shrink past it without the wordmark overflowing the edge.
const MIN_WIDTH = 13 * 16;
const MAIN_CONTENT_MIN_WIDTH = 30 * 16;
const BOUNDS = { minWidth: MIN_WIDTH, mainContentMinWidth: MAIN_CONTENT_MIN_WIDTH };

export function useSidebarWidth() {
  const panelOpen = useRightPanelStore((state) => state.open);
  const maximized = useRightPanelStore((state) => state.maximized);
  const panelDocked = panelOpen && !maximized;
  const { width: windowWidth } = useWindowSize();
  const { value: storedPanel } = useLocalStorageValue(RIGHT_PANEL_STORAGE_KEY, {
    defaultValue: RIGHT_PANEL_DEFAULT_WIDTH,
    initializeWithValue: true,
  });
  const {
    value: storedSidebar,
    set,
    remove,
  } = useLocalStorageValue(STORAGE_KEY, {
    defaultValue: DEFAULT_WIDTH,
    initializeWithValue: true,
  });

  const sidebarPass = clampResizableWidth(storedSidebar, windowWidth, BOUNDS);
  const panelReserved = panelDocked
    ? clampResizableWidth(storedPanel, windowWidth, {
        minWidth: RIGHT_PANEL_MIN_WIDTH,
        mainContentMinWidth: MAIN_CONTENT_MIN_WIDTH,
        reservedWidth: sidebarPass,
      })
    : 0;
  const width = clampResizableWidth(storedSidebar, windowWidth, { ...BOUNDS, reservedWidth: panelReserved });
  const setWidth = (next: number) =>
    set(clampResizableWidth(next, windowWidth, { ...BOUNDS, reservedWidth: panelReserved }));
  const reset = () => remove();

  return { width, setWidth, reset };
}

interface DragState {
  startX: number;
  startWidth: number;
  width: number;
  wrapper: HTMLElement;
  transitionTargets: HTMLElement[];
  rightPanelRegion: HTMLElement | null;
}

export function SidebarResizeHandle({
  onCommit,
  onReset,
}: {
  onCommit: (width: number) => void;
  onReset: () => void;
}) {
  const { state, isMobile } = useSidebar();
  const dragRef = useRef<DragState | null>(null);

  if (isMobile || state !== "expanded") return null;

  const beginDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const rail = event.currentTarget;
    const wrapper = rail.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
    if (!wrapper) return;
    const container = wrapper.querySelector<HTMLElement>("[data-slot='sidebar-container']");
    const startWidth = container?.getBoundingClientRect().width ?? DEFAULT_WIDTH;
    // Suppress the width transition so the drag tracks the cursor 1:1.
    const transitionTargets = [
      wrapper.querySelector<HTMLElement>("[data-slot='sidebar-gap']"),
      container,
    ].filter((element): element is HTMLElement => element !== null);
    for (const element of transitionTargets) {
      element.style.setProperty("transition-duration", "0ms");
    }
    const rightPanelRegion = rightPanelRegionElement(wrapper);
    rightPanelRegion?.style.setProperty("transition-duration", "0ms");

    event.preventDefault();
    rail.setPointerCapture(event.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    dragRef.current = {
      startX: event.clientX,
      startWidth,
      width: startWidth,
      wrapper,
      transitionTargets,
      rightPanelRegion,
    };
  };

  const updateDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    event.preventDefault();
    drag.width = clampResizableWidth(drag.startWidth + (event.clientX - drag.startX), window.innerWidth, {
      ...BOUNDS,
      reservedWidth: reservedOpenRightPanelWidth(drag.wrapper),
    });
    drag.wrapper.style.setProperty("--sidebar-width", `${drag.width}px`);
    reclampOpenRightPanelWidth(drag.wrapper);
  };

  const endDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    for (const element of drag.transitionTargets) {
      element.style.removeProperty("transition-duration");
    }
    drag.rightPanelRegion?.style.removeProperty("transition-duration");
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
      aria-label="Resize sidebar"
      title="Drag to resize · double-click to reset"
      tabIndex={-1}
      onPointerDown={beginDrag}
      onPointerMove={updateDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      className="fixed inset-y-0 left-[var(--sidebar-width)] z-30 w-2 -translate-x-1/2 cursor-col-resize touch-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent hover:after:bg-sidebar-border"
    />
  );
}
