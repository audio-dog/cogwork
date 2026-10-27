const linkSchemes = new Set(["http:", "https:", "mailto:"]);

/**
 * Agent and connector output reaches these links, so a `javascript:` or `data:` href would
 * execute in the renderer when clicked. `target`/`rel` do not stop that.
 */
export const safeHref = (href: string | undefined) => {
  if (!href) return undefined;
  if (href.startsWith("#") || href.startsWith("/")) return href;
  try {
    return linkSchemes.has(new URL(href, "https://localhost").protocol) ? href : undefined;
  } catch {
    return undefined;
  }
};
