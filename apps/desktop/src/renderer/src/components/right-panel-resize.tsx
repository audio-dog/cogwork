import { useSidebar } from "@cogwork/ui/components/sidebar";
import { useEffect, useRef } from "react";
import { clampResizableWidth, useResizableWidth } from "./resizable-width";

const STORAGE_KEY = "cf.rightPanelWidth";
const DEFAULT_WIDTH = 30 * 16;
const MIN_WIDTH = 22 * 16;
// Keep the main column usable no matter how wide the panel is dragged.
const MAIN_CONTENT_MIN_WIDTH = 30 * 16;

function rightPanelBounds(sidebarWidth: number, sidebarExpanded: boolean) {
  return {
    minWidth: MIN_WIDTH,
    mainContentMinWidth: MAIN_CONTENT_MIN_WIDTH,
    reservedWidth: sidebarExpanded ? sidebarWidth : 0,
  };
}

function insetWidth(wrapper: HTMLElement): number {
  const inset = wrapper.querySelector<HTMLElement>("[data-slot='sidebar-inset']");
  return inset?.getBoundingClientRect().width ?? window.innerWidth;
}

export function useRightPanelWidth(sidebarWidth: number) {
  const { state } = useSidebar();
  const bounds = rightPanelBounds(sidebarWidth, state === "expanded");
  const panel = useResizableWidth({ storageKey: STORAGE_KEY, defaultWidth: DEFAULT_WIDTH, ...bounds });

  // The CSS var lives on SidebarProvider in __root__; sync it from here where we
  // know the clamped width (inside the provider tree).
  useEffect(() => {
    document
      .querySelector<HTMLElement>("[data-slot='sidebar-wrapper']")
      ?.style.setProperty("--right-panel-width", `${panel.width}px`);
  }, [panel.width]);

  return panel;
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
    const startWidth = region?.getBoundingClientRect().width ?? DEFAULT_WIDTH;
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
      {
        minWidth: MIN_WIDTH,
        mainContentMinWidth: MAIN_CONTENT_MIN_WIDTH,
      },
    );
    drag.wrapper.style.setProperty("--right-panel-width", `${drag.width}px`);
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
