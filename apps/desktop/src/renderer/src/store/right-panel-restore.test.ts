import { describe, expect, it, vi } from "vitest";

const { storageEntries } = vi.hoisted(() => {
  const entries = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
    },
  });
  return { storageEntries: entries };
});

async function restore(persisted: unknown) {
  storageEntries.clear();
  storageEntries.set("right-panel", JSON.stringify({ state: persisted, version: 0 }));
  vi.resetModules();
  const { useRightPanelStore } = await import("./right-panel");
  return useRightPanelStore.getState();
}

describe("restoring persisted surfaces", () => {
  it("keeps the surfaces it recognises", async () => {
    const state = await restore({
      surfaces: [
        { id: "terminal", kind: "terminal" },
        {
          id: "file:~/a/SKILL.md",
          kind: "file",
          path: "~/a/SKILL.md",
          title: "SKILL.md",
        },
      ],
      active: "terminal",
    });
    expect(state.surfaces.map((surface) => surface.kind)).toEqual(["terminal", "file"]);
    expect(state.active).toBe("terminal");
  });

  it("drops a surface kind it does not know", async () => {
    const state = await restore({ surfaces: [{ id: "wat", kind: "wat" }], active: "wat" });
    expect(state.surfaces).toEqual([]);
    expect(state.active).toBeNull();
  });

  it("drops a file surface missing its fields", async () => {
    const state = await restore({ surfaces: [{ id: "file:x", kind: "file" }], active: "file:x" });
    expect(state.surfaces).toEqual([]);
  });

  it("survives surfaces that are not an array", async () => {
    const state = await restore({ surfaces: "nope", active: 7 });
    expect(state.surfaces).toEqual([]);
    expect(state.active).toBeNull();
  });

  it("falls back to the last surface when the active id is stale", async () => {
    const state = await restore({
      surfaces: [{ id: "activity", kind: "activity" }],
      active: "gone",
    });
    expect(state.active).toBe("activity");
  });
});
