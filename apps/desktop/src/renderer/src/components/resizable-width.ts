import { useLocalStorageValue, useWindowSize } from "@react-hookz/web";

export interface ResizableWidthBounds {
  readonly minWidth: number;
  // Width the neighbouring column must always keep, so the panel never eats the whole window.
  readonly mainContentMinWidth: number;
}

export function clampResizableWidth(
  width: number,
  viewportWidth: number,
  bounds: ResizableWidthBounds,
): number {
  const max = Math.max(bounds.minWidth, Math.floor(viewportWidth) - bounds.mainContentMinWidth);
  return Math.min(Math.max(width, bounds.minWidth), max);
}

// Persistent, viewport-clamped width for a resizable panel. Shared by the left sidebar
// and the right side panel; the only difference between them is the bounds and storage key.
export function useResizableWidth(
  config: ResizableWidthBounds & { storageKey: string; defaultWidth: number },
) {
  const { width: windowWidth } = useWindowSize();
  const {
    value: storedWidth,
    set,
    remove,
  } = useLocalStorageValue(config.storageKey, {
    defaultValue: config.defaultWidth,
    initializeWithValue: true,
  });

  const setWidth = (next: number) => set(clampResizableWidth(next, window.innerWidth, config));
  const reset = () => remove();

  return { width: clampResizableWidth(storedWidth, windowWidth, config), setWidth, reset };
}
