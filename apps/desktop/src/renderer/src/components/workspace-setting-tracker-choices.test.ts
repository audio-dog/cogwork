import { describe, expect, it } from "vitest";

import { assigneeItems, teamItems, unloadedItems } from "./workspace-setting-tracker-choices";

describe("assignee allowlist choices", () => {
  const ada = { identity: "0b6d9c1e-7a2f-4c3d-9e8b-1a2b3c4d5e6f", label: "Ada Lovelace" };

  it("marks a stored identity the loaded people list lacks as unknown so it can be removed", () => {
    expect(assigneeItems([ada], ["taylor.steele", ada.identity])).toEqual([
      { value: "taylor.steele", label: "Unknown: taylor.steele" },
      { value: ada.identity, label: "Ada Lovelace" },
    ]);
  });

  it("does not call a stored identity unknown while the people list has not loaded", () => {
    expect(unloadedItems([ada.identity])).toEqual([{ value: ada.identity, label: ada.identity }]);
  });
});

describe("Linear team choices", () => {
  const platform = { key: "PROD", name: "Platform" };

  it("stores a chosen team by its key and shows its name beside the key", () => {
    expect(teamItems([platform], [])).toEqual([{ value: "PROD", label: "Platform (PROD)" }]);
  });

  it("marks a stored team the loaded list lacks as unknown so it can be removed", () => {
    expect(teamItems([platform], ["Platform", "PROD"])).toEqual([
      { value: "Platform", label: "Unknown: Platform" },
      { value: "PROD", label: "Platform (PROD)" },
    ]);
  });
});
