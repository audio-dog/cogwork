// @vitest-environment happy-dom

import type { WorkflowOption } from "@cogwork/contracts";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buttonNamed,
  catalog,
  disposers,
  eventually,
  everyRecord,
  listFrom,
  machine,
  mountEditor,
  record,
  transitionRecord,
} from "./workflow-session-fixtures";
import type { ListWorkflowOptions } from "./working-copy-provider";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

vi.mock("@tanstack/react-router", async (importOriginal) =>
  (await import("./workflow-session-router-fixtures")).mockedRouter(await importOriginal()),
);

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

describe("WorkflowEditor", () => {
  it("keeps action options with their answer after removing an earlier action", async () => {
    const loadingOptions = Promise.withResolvers<never>();
    const { container, root, daemon } = await mountEditor(transitionRecord, {
      listOptions: listFrom(() => loadingOptions.promise),
    });
    await daemon((probe) => probe.holdReplies);
    const remove = container.querySelectorAll<HTMLButtonElement>('[aria-label="Remove Done"]');
    expect(remove).toHaveLength(2);
    await act(async () => remove[0]?.click());

    await eventually(() =>
      expect(container.querySelectorAll<HTMLButtonElement>('[aria-label="Done target"]')).toHaveLength(1),
    );
    const parameter = container.querySelectorAll<HTMLButtonElement>('[aria-label="Done target"]');
    await act(async () => parameter[0]?.click());
    expect(
      [...document.querySelectorAll('[role="menuitemradio"]')].map(({ textContent }) => textContent),
    ).toContain("second");
    await daemon((probe) => probe.releaseReplies);
    await act(async () => root.unmount());
  });

  it("shows loading only until the first list of trigger options arrives", async () => {
    const firstListing = Promise.withResolvers<ReadonlyArray<WorkflowOption>>();
    const refresh = Promise.withResolvers<ReadonlyArray<WorkflowOption>>();
    const listings = [firstListing.promise, refresh.promise];
    const { container, root } = await mountEditor(everyRecord, {
      listOptions: listFrom(() => listings.shift() ?? refresh.promise),
    });
    const parameter = container.querySelector<HTMLButtonElement>('[aria-label="Started target"]');
    if (!parameter) throw new Error("Trigger parameter did not render");
    const menu = () => document.querySelector('[role="menu"]');
    const optionTexts = () =>
      [...document.querySelectorAll('[role="menuitemradio"]')].map(({ textContent }) => textContent);

    await act(async () => parameter.click());
    expect(menu()?.textContent).toContain("Loading");
    firstListing.resolve([{ value: "needs-triage", name: "needs-triage", listedIn: [] }]);
    await eventually(() => expect(optionTexts()).toEqual(["needs-triage"]));
    expect(menu()?.textContent).not.toContain("Loading");

    await act(async () => parameter.click());
    await act(async () => parameter.click());
    expect(parameter.getAttribute("aria-expanded")).toBe("true");
    expect(optionTexts()).toEqual(["needs-triage"]);
    expect(menu()?.textContent).not.toContain("Loading");
    await act(async () => root.unmount());
  });

  it("keeps an action's listed options when the Add Action menu opens again", async () => {
    const firstListing = Promise.withResolvers<ReadonlyArray<WorkflowOption>>();
    const refresh = Promise.withResolvers<ReadonlyArray<WorkflowOption>>();
    const listings = [firstListing.promise, refresh.promise];
    const { container, root } = await mountEditor(everyRecord, {
      listOptions: listFrom(() => listings.shift() ?? refresh.promise),
    });
    const addAction = buttonNamed(container, "Add Action");
    if (!addAction) throw new Error("Add Action did not render");
    const menuItem = (text: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        ({ textContent }) => textContent === text,
      );
    const openDoneValues = async () => {
      await act(async () => addAction.click());
      await act(async () => menuItem("Test")?.click());
      await act(async () => menuItem("Done…")?.click());
    };

    await openDoneValues();
    expect(document.body.textContent).toContain("Loading");
    firstListing.resolve([{ value: "needs-triage", name: "needs-triage", listedIn: [] }]);
    await eventually(() => expect(menuItem("needs-triage")).toBeDefined());

    await act(async () => addAction.click());
    expect(menuItem("needs-triage")).toBeUndefined();
    await openDoneValues();
    expect(menuItem("needs-triage")).toBeDefined();
    expect(document.body.textContent).not.toContain("Loading");
    await act(async () => root.unmount());
  });

  it("keeps the newest options when an older read settles last", async () => {
    const older = Promise.withResolvers<ReadonlyArray<WorkflowOption>>();
    const newer = Promise.withResolvers<ReadonlyArray<WorkflowOption>>();
    const listings = [older.promise, newer.promise];
    const { container, root } = await mountEditor(everyRecord, {
      listOptions: listFrom(() => listings.shift() ?? newer.promise),
    });
    const parameter = container.querySelector<HTMLButtonElement>('[aria-label="Started target"]');
    if (!parameter) throw new Error("Trigger parameter did not render");
    const optionTexts = () =>
      [...document.querySelectorAll('[role="menuitemradio"]')].map(({ textContent }) => textContent);

    await act(async () => parameter.click());
    await act(async () => parameter.click());
    await act(async () => parameter.click());
    newer.resolve([{ value: "new", name: "new", listedIn: [] }]);
    await eventually(() => expect(optionTexts()).toEqual(["new"]));
    older.resolve([{ value: "old", name: "old", listedIn: [] }]);
    await act(() => older.promise);
    expect(optionTexts()).toEqual(["new"]);
    await act(async () => root.unmount());
  });

  it("lists options for every ready workspace when the Workflow selects Every", async () => {
    const listOptions = vi.fn<
      (...args: Parameters<ListWorkflowOptions>) => Promise<ReadonlyArray<WorkflowOption>>
    >(async () => []);
    const { container, root } = await mountEditor(everyRecord, { listOptions: listFrom(listOptions) });
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Started target"]');
    if (!trigger) throw new Error("Trigger parameter menu did not render");

    await act(async () => trigger.click());

    await eventually(() =>
      expect(listOptions).toHaveBeenCalledWith(
        catalog.entries[0]?.key,
        "target",
        machine.workspaces.map(({ id }) => id),
      ),
    );
    await act(async () => root.unmount());
  });

  it("keeps a stored workspace in the menu before readiness loads", async () => {
    const { container, root } = await mountEditor(record, { session: {} });

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Workspaces"]');
    if (!trigger) throw new Error("Workspace menu did not render");
    await act(async () => trigger.click());

    expect(
      [...document.querySelectorAll('[role="option"]')].some(({ textContent }) =>
        textContent?.includes("cogwork"),
      ),
    ).toBe(true);
    await act(async () => root.unmount());
  });

  it("names each workspace in the menu instead of showing its id", async () => {
    const workspaceLabels = new Map([
      ["cogwork", "Cogwork"],
      ["first", "First repository"],
      ["second", "Second repository"],
    ]);
    const { container, root } = await mountEditor(record, { session: { machine, workspaceLabels } });

    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Workspaces"]');
    if (!trigger) throw new Error("Workspace menu did not render");
    expect(trigger.textContent).toContain("Cogwork");
    await act(async () => trigger.click());

    const options = [...document.querySelectorAll('[role="option"]')].map(({ textContent }) => textContent);
    expect(options).toEqual(expect.arrayContaining(["Cogwork", "First repository", "Second repository"]));
    expect(options).not.toContain("first");
    await act(async () => root.unmount());
  });
});
