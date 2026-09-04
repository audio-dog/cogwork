import { describe, expect, it } from "vitest";
import { contributionKinds } from "./configuration-model";
import { defaultFacet, facetFromSlug, facetLabel, facetSlug, facets } from "./customize-facets";

describe("facet slugs", () => {
  it("covers Plugins and every contribution kind", () => {
    expect(facets).toEqual(["plugins", ...contributionKinds]);
  });

  it("round-trips every facet through its slug", () => {
    for (const facet of facets) expect(facetFromSlug(facetSlug(facet))).toBe(facet);
  });

  it("gives every facet a distinct slug", () => {
    const slugs = facets.map(facetSlug);
    expect(new Set(slugs).size).toBe(facets.length);
  });

  it("rejects an unknown slug so the route can redirect", () => {
    expect(facetFromSlug("operations")).toBeUndefined();
    expect(facetFromSlug("nope")).toBeUndefined();
    expect(facetFromSlug("")).toBeUndefined();
    expect(facetFromSlug("mcp-server")).toBeUndefined();
  });

  it("has a resolvable default", () => {
    expect(facetFromSlug(facetSlug(defaultFacet))).toBe(defaultFacet);
  });

  it("labels a facet without leaking the kind id", () => {
    expect(facetLabel("plugins")).toBe("Plugins");
    expect(facetLabel("mcp-server")).toBe("MCP servers");
  });
});
