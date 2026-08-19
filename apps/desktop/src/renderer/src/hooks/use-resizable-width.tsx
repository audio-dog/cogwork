import { useLocalStorageValue, useWindowSize } from "@react-hookz/web";

export interface ResizableWidthBounds {
  minWidth: number;
  // Width the neighbouring column must always keep, so the panel never eats the whole window.
  mainContentMinWidth: number;
  // Chrome already occupying horizontal space (e.g. an expanded left sidebar or open side panel).
  reservedWidth?: number;
}

export function clampResizableWidth(
  width: number,
  containerWidth: number,
  bounds: ResizableWidthBounds,
): number {
  const reserved = bounds.reservedWidth ?? 0;
  const max = Math.max(bounds.minWidth, Math.floor(containerWidth) - reserved - bounds.mainContentMinWidth);
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

  const containerWidth = windowWidth;
  const setWidth = (next: number) => set(clampResizableWidth(next, containerWidth, config));
  const reset = () => remove();

  return { width: clampResizableWidth(storedWidth, containerWidth, config), setWidth, reset };
}
