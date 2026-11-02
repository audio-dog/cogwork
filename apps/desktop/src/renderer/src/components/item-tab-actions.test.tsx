import { ClassifiedItem, initialBoard, itemKey, WorkspaceId } from "@cogwork/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handBackAtom, handBackTargetAtom } from "../daemon/atoms";
import {
  type ActivitySession,
  ActivitySessionContext,
  initialActivitySession,
} from "../features/activity-session";
import { ItemTab } from "./item-tab";

interface CapturedButton {
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
}

const buttons: Array<CapturedButton> = vi.hoisted(() => []);
const atomWrites: Array<{ readonly atom: unknown; readonly value: unknown }> = vi.hoisted(() => []);
const atomValues: Map<unknown, unknown> = vi.hoisted(() => new Map());

vi.mock("@cogwork/ui/components/button", () => ({
  Button: ({ children, disabled, onClick }: CapturedButton) => {
    buttons.push({ children, disabled, onClick });
    return (
      <button type="button" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    );
  },
}));

vi.mock("@effect/atom-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/atom-react")>();
  return {
    ...actual,
    useAtom: (atom: unknown) => [
      atomValues.get(atom) ?? { _tag: "Initial", waiting: false },
      (value: unknown) => atomWrites.push({ atom, value }),
    ],
  };
});

const classifiedItem = Schema.decodeSync(ClassifiedItem);
const workspace = Schema.decodeSync(WorkspaceId)("acme");

const sessionFor = (item: ClassifiedItem): ActivitySession => ({
  ...initialActivitySession,
  connection: "live",
  board: {
    ...initialBoard,
    items: new Map([[itemKey(workspace, item.id), { workspace, item }]]),
  },
});

const renderItem = (item: ClassifiedItem) =>
  renderToStaticMarkup(
    <ActivitySessionContext value={sessionFor(item)}>
      <ItemTab selection={{ workspace, workItem: item.id }} />
    </ActivitySessionContext>,
  );

const buttonLabel = ({ children }: CapturedButton) => renderToStaticMarkup(children);

describe("ItemTab Hand back", () => {
  beforeEach(() => {
    buttons.length = 0;
    atomWrites.length = 0;
    atomValues.clear();
    atomValues.set(handBackTargetAtom, null);
  });

  it("offers Hand back beside Reclassify only for a needs-human item", () => {
    const needsHuman = classifiedItem({
      _tag: "NeedsHuman",
      id: "42",
      title: "Repair the worktree",
      reason: "ready-for-human",
      proposal: null,
      url: null,
    });
    const eligible = classifiedItem({
      _tag: "Eligible",
      id: "43",
      title: "Continue work",
      stage: "implement",
      url: null,
    });

    const needsHumanMarkup = renderItem(needsHuman);
    expect(needsHumanMarkup.indexOf("Hand back")).toBeGreaterThan(needsHumanMarkup.indexOf("Reclassify"));
    expect(renderItem(eligible)).not.toContain("Hand back");
  });

  it("keeps attention state and AI suggestion in the warning palette", () => {
    const item = classifiedItem({
      _tag: "NeedsHuman",
      id: "42",
      title: "Repair the worktree",
      reason: "ready-for-human",
      proposal: "Return this item to the agent.",
      url: null,
    });

    expect(renderItem(item).match(/bg-warning\/15/g)).toHaveLength(2);
  });

  it("dispatches HandBack for the selected Workflow item", () => {
    const item = classifiedItem({
      _tag: "NeedsHuman",
      id: "42",
      title: "Repair the worktree",
      reason: "ready-for-human",
      proposal: null,
      url: null,
    });

    renderItem(item);
    const handBack = buttons.find((button) => buttonLabel(button).includes("Hand back"));
    handBack?.onClick?.();

    expect(atomWrites).toContainEqual({
      atom: handBackTargetAtom,
      value: { workspace: "acme", workItem: "42" },
    });
    expect(atomWrites).toContainEqual({
      atom: handBackAtom,
      value: {
        payload: {
          item: { _tag: "Issue", workspace: "acme", id: "42" },
        },
      },
    });
  });

  it("disables role actions while HandBack is pending", () => {
    const item = classifiedItem({
      _tag: "NeedsHuman",
      id: "42",
      title: "Repair the worktree",
      reason: "ready-for-human",
      proposal: null,
      url: null,
    });
    atomValues.set(handBackTargetAtom, { workspace: "acme", workItem: "42" });
    atomValues.set(handBackAtom, AsyncResult.initial(true));

    renderItem(item);

    expect(
      buttons
        .filter((button) => ["Approve", "Reclassify", "Hand back"].includes(buttonLabel(button)))
        .every((button) => button.disabled),
    ).toBe(true);
  });

  it("shows HandBack failure only on the originating item", () => {
    const item = classifiedItem({
      _tag: "NeedsHuman",
      id: "42",
      title: "Repair the worktree",
      reason: "ready-for-human",
      proposal: null,
      url: null,
    });
    atomValues.set(handBackAtom, AsyncResult.failure(Cause.fail(new Error("hand back failed"))));
    atomValues.set(handBackTargetAtom, { workspace: "acme", workItem: "42" });
    expect(renderItem(item)).toContain("hand back failed");

    atomValues.set(handBackTargetAtom, { workspace: "acme", workItem: "43" });
    expect(renderItem(item)).not.toContain("hand back failed");
  });
});
