import { readFileSync } from "node:fs";

import { WorkflowDocument } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { importReviewMarks } from "./workflow-import-review";

const decodeDocument = Schema.decodeUnknownSync(WorkflowDocument);

const fixture = decodeDocument(
  JSON.parse(
    readFileSync(
      new URL("../../../../fixtures/imported-workflow-causing-highlights.json", import.meta.url),
      "utf8",
    ),
  ),
);

const quiet = decodeDocument({
  name: "Shared conventions",
  workspaces: { _tag: "Every" },
  triggers: [
    {
      id: "finding",
      entry: "github.new-finding-from-bot",
      parameters: [
        { id: "bot", value: "" },
        { id: "label", value: "bug" },
        { id: "author", value: "me" },
      ],
      start: "reply",
    },
  ],
  operations: [
    {
      id: "reply",
      name: "Reply",
      instructionPackage: null,
      instruction: "Draft a reply.",
      permissionProfile: "read-only",
      commands: { allow: [], deny: [] },
      connections: [],
      requires: [],
      model: { harness: null, model: null, options: [] },
      forEach: null,
      questions: [],
      transitions: [
        {
          when: [],
          actions: [{ entry: "github.request-review", parameters: [{ id: "reviewer", value: "  " }] }],
          handOff: null,
        },
      ],
      hints: [],
    },
  ],
});

describe("importReviewMarks", () => {
  it("marks workspaces, harnesses, tools, and personal parameters that arrived with a file", () => {
    expect(importReviewMarks(fixture)).toEqual([
      "workspaces",
      "trigger:bot-finding:bot",
      "trigger:mentioned:channel",
      "model:follow-up",
      "requires:follow-up",
      "action:follow-up:0:0:reviewer",
    ]);
  });

  it("leaves every workspace, blank models, and shared fields unmarked", () => {
    expect(importReviewMarks(quiet)).toEqual([]);
  });
});
