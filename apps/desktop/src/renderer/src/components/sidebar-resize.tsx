import { useSidebar } from "@clanker-forge/ui/components/sidebar";
import { useRef, useState, useSyncExternalStore } from "react";

const STORAGE_KEY = "cf.sidebarWidth";
const DEFAULT_WIDTH = 16 * 16;
// Intentionally narrower than the brand needs: below the sidebar header's
// container-query threshold (15.75rem, see nav-sidebar) the brand hides itself,
// so the sidebar can shrink past it without the wordmark overflowing the edge.
const MIN_WIDTH = 13 * 16;
const MAIN_CONTENT_MIN_WIDTH = 30 * 16;

function resolveMaxWidth(viewportWidth: number) {
  return Math.max(MIN_WIDTH, Math.floor(viewportWidth) - MAIN_CONTENT_MIN_WIDTH);
}

function clampWidth(width: number, viewportWidth: number) {
  return Math.min(Math.max(width, MIN_WIDTH), resolveMaxWidth(viewportWidth));
}

function readStoredWidth() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeStoredWidth(width: number) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(width));
  } catch {}
}

function clearStoredWidth() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

function subscribeWindowWidth(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function useWindowWidth() {
  return useSyncExternalStore(
    subscribeWindowWidth,
    () => window.innerWidth,
    () => Number.POSITIVE_INFINITY,
  );
}

export function useSidebarWidth() {
  const windowWidth = useWindowWidth();
  const [storedWidth, setStoredWidth] = useState(() => readStoredWidth() ?? DEFAULT_WIDTH);

  const setWidth = (next: number) => {
    const clamped = clampWidth(next, window.innerWidth);
    setStoredWidth(clamped);
    writeStoredWidth(clamped);
  };

  const reset = () => {
    setStoredWidth(DEFAULT_WIDTH);
    clearStoredWidth();
  };

  return { width: clampWidth(storedWidth, windowWidth), setWidth, reset };
}

interface DragState {
  startX: number;
  startWidth: number;
  width: number;
  wrapper: HTMLElement;
  transitionTargets: HTMLElement[];
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
    };
  };

  const updateDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    event.preventDefault();
    drag.width = clampWidth(drag.startWidth + (event.clientX - drag.startX), window.innerWidth);
    drag.wrapper.style.setProperty("--sidebar-width", `${drag.width}px`);
  };

  const endDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    for (const element of drag.transitionTargets) {
      element.style.removeProperty("transition-duration");
    }
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
