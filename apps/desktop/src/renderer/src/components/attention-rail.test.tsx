// @vitest-environment happy-dom

import { applyDaemonEvent, DaemonEvent, initialBoard } from "@cogwork/contracts";
import * as Schema from "effect/Schema";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";

import { ActivitySessionContext, initialActivitySession } from "../features/activity-session";
import { AttentionList } from "./attention-rail";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const decodeDaemonEvent = Schema.decodeUnknownSync(DaemonEvent);
const cogwork = "01a1a28e-b763-7ccb-9208-2b284d962dae";
const web = "01a1ebe3-5c4d-7a8b-9c0d-1e2f3a4b5c6d";

const registered = (id: string, displayName: string) => ({
  _tag: "WorkspaceChanged",
  workspace: {
    _tag: "Registered",
    id,
    displayName,
    checkoutPath: `/repos/${displayName}`,
    issueTracker: "github",
    record: {
      displayName,
      checkoutPath: `/repos/${displayName}`,
      issueTracker: { type: "github" },
      linearHistory: false,
    },
    contributions: [],
  },
});

const readyToMerge = (workspace: string, id: string, title: string) => ({
  _tag: "ItemChanged",
  workspace,
  item: {
    _tag: "ReadyToMerge",
    id,
    title,
    url: null,
    pr: {
      number: 7,
      url: "https://example.test/pr/7",
      checks: "passing",
      review: "ready",
      baseDivergence: "none",
      waitingSinceMillis: 0,
    },
  },
});

const board = [
  registered(cogwork, "cogwork"),
  registered(web, "web"),
  readyToMerge(cogwork, "#53", "Fix the badge"),
  readyToMerge(web, "#61", "Fix the rail"),
]
  .map((event) => decodeDaemonEvent({ ...event, emittedAtMillis: 0 }))
  .reduce(applyDaemonEvent, initialBoard);

const leafTexts = (root: ParentNode) =>
  [...root.querySelectorAll<HTMLElement>("*")]
    .filter((node) => node.children.length === 0)
    .map((node) => node.textContent?.trim() ?? "");

it("names workspaces by display name in the rows and the filter, and filters by workspace id", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ActivitySessionContext value={{ ...initialActivitySession, connection: "live", board }}>
        <AttentionList />
      </ActivitySessionContext>,
    );
  });

  expect(leafTexts(container)).toEqual(expect.arrayContaining(["cogwork", "web"]));

  const filter = container.querySelector<HTMLButtonElement>('button[aria-label="Filter workspaces"]');
  await act(async () => filter?.click());
  const menu = [...document.body.querySelectorAll("label")];
  expect(menu.map((label) => label.textContent)).toEqual(["cogwork1", "web1"]);

  await act(async () => menu[0]?.querySelector("input")?.click());

  expect(container.textContent).toContain("Fix the badge");
  expect(container.textContent).not.toContain("Fix the rail");
  expect(document.body.textContent).not.toContain(cogwork);
  expect(document.body.textContent).not.toContain(web);
  await act(async () => root.unmount());
  container.remove();
});
