import { describe, expect, it } from "vitest";

import { McpReadiness } from "../features/configuration-model";
import { contributionById } from "../testing/configuration";
import { emptyReason, searchEmptyReason } from "./customize-empty";
import { readinessCopy } from "./mcp-configure-dialog";

describe("emptyReason", () => {
  it("blames the Place filter when nothing is picked", () => {
    expect(emptyReason([], "")).toBe("no-places");
    expect(emptyReason([], "linear")).toBe("no-places");
  });

  it("blames the search when a query is in play", () => {
    // Without this the list said "none yet", which reads as a status rather than a filter result.
    expect(emptyReason(["settings-profile"], "linear")).toBe("no-match");
    expect(emptyReason(["settings-profile"], "  linear  ")).toBe("no-match");
  });

  it("says there is genuinely nothing only when no filter is narrowing", () => {
    expect(emptyReason(["settings-profile"], "")).toBe("none-yet");
    expect(emptyReason(["settings-profile"], "   ")).toBe("none-yet");
  });
});

describe("searchEmptyReason", () => {
  it("has no Place cause, because a Plugin install is machine-local", () => {
    expect(searchEmptyReason("granola")).toBe("no-match");
    expect(searchEmptyReason("")).toBe("none-yet");
    expect(searchEmptyReason("  ")).toBe("none-yet");
  });
});

describe("readinessCopy", () => {
  function required(id: string) {
    const contribution = contributionById(id);
    if (!contribution) throw new Error(`fixture is missing ${id}`);
    return contribution;
  }

  it("reports the Engine's verdict when it reached one", () => {
    const copy = readinessCopy(required("plugin:linear/mcp/linear"));
    expect(copy.title).toBe("Ready");
    expect(copy.detail).toContain("Launchable");
  });

  it("claims no verdict for a server the Engine never started", () => {
    // Granola's file will not load, so `readiness` is absent. Neither "Ready" nor "Not ready" is
    // true, and pairing either with the success copy makes the two lines disagree.
    const granola = required("plugin:granola/mcp/granola");
    expect(granola.readiness).toBeUndefined();

    const copy = readinessCopy(granola);
    expect(copy.title).toBe("Not checked");
    expect(copy.detail).not.toContain("Launchable");
    expect(copy.detail).toContain("didn't load");
    expect(copy.output).toBe(true);
  });

  it("passes the Engine's own reason through when it says not ready", () => {
    const copy = readinessCopy({
      ...required("plugin:linear/mcp/linear"),
      readiness: McpReadiness["not-ready"]({ reason: "The command exited before the handshake." }),
    });
    expect(copy.title).toBe("Not ready");
    expect(copy.detail).toBe("The command exited before the handshake.");
    expect(copy.output).toBe(true);
  });
});
