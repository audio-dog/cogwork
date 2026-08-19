import { useRef } from "react";
import { clampResizableWidth, useResizableWidth } from "./resizable-width";

const STORAGE_KEY = "cf.rightPanelWidth";
const DEFAULT_WIDTH = 30 * 16;
const MIN_WIDTH = 22 * 16;
// Keep the main column usable no matter how wide the panel is dragged.
const MAIN_CONTENT_MIN_WIDTH = 30 * 16;
const BOUNDS = { minWidth: MIN_WIDTH, mainContentMinWidth: MAIN_CONTENT_MIN_WIDTH };

export function useRightPanelWidth() {
  return useResizableWidth({ storageKey: STORAGE_KEY, defaultWidth: DEFAULT_WIDTH, ...BOUNDS });
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
    dragRef.current = { startX: event.clientX, startWidth, width: startWidth, wrapper, region };
  };

  const updateDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    event.preventDefault();
    // Dragging the left edge leftward widens the panel.
    drag.width = clampResizableWidth(
      drag.startWidth - (event.clientX - drag.startX),
      window.innerWidth,
      BOUNDS,
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
