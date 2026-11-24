// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buttonNamed,
  eventually,
  everyRecord,
  filterCatalog,
  machine,
  mountEditor,
  record,
  typeInto,
  unmountEditors,
} from "./workflow-session-fixtures";
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

vi.mock("@tanstack/react-router", async (importOriginal) =>
  (await import("../testing/router-links")).withRouterLinks(
    await importOriginal<typeof import("@tanstack/react-router")>(),
  ),
);

afterEach(unmountEditors);

describe("WorkflowEditor", () => {
  it("saves a name typed with a trailing space as the trimmed name, then publishes it", async () => {
    const { container, root, daemon } = await mountEditor(everyRecord);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Workflow name"]');
    if (!input) throw new Error("Workflow name input did not render");

    input.focus();
    await typeInto(input, "Triage ");
    await act(async () => input.blur());
    await eventually(() => expect(input.value).toBe("Triage"));
    const save = buttonNamed(container, "Save");
    await act(async () => save?.click());

    await eventually(async () =>
      expect((await daemon((probe) => probe.record(everyRecord.id)))?.publishedRevision).toBe(2),
    );
    expect((await daemon((probe) => probe.calls)).map(({ _tag }) => _tag)).toEqual(["edit", "publish"]);
    expect((await daemon((probe) => probe.record(everyRecord.id)))?.publishedCopy?.name).toBe("Triage");
    await act(async () => root.unmount());
  });

  it("keeps the typed outcome name through a pause and shows the saved name on blur", async () => {
    vi.useFakeTimers();
    const pause = () => vi.advanceTimersByTimeAsync(600);
    const { container, root, daemon } = await mountEditor(everyRecord);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Outcome 1"]');
    if (!input) throw new Error("Outcome name input did not render");

    input.focus();
    await typeInto(input, "");
    await act(pause);
    expect(input.value).toBe("");
    await typeInto(input, "ready ");
    await act(pause);
    expect(input.value).toBe("ready ");
    await typeInto(input, "ready for agent ");
    await act(async () => input.blur());
    await act(pause);

    expect(input.value).toBe("ready for agent");
    const saved = await daemon((probe) => probe.record(everyRecord.id));
    expect(saved?.workingCopy.operations[0]?.questions[0]?.choices[0]?.name).toBe("ready for agent");
    await act(async () => root.unmount());
  });

  it("removes the only question so the Operation has no outcomes to answer", async () => {
    const { container, root, daemon } = await mountEditor(everyRecord);
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove question 1"]');
    if (!remove) throw new Error("The only question has no remove control");

    await act(async () => remove.click());

    await eventually(() => expect(container.querySelector('input[aria-label="Question 1"]')).toBeNull());
    expect(await daemon((probe) => probe.calls)).toEqual([
      {
        _tag: "edit",
        id: everyRecord.id,
        edits: [{ _tag: "RemoveQuestion", operation: "work", question: "outcome" }],
      },
    ]);
    await act(async () => root.unmount());
  });

  it("adds a Trigger filter from the filters that apply, and removes it", async () => {
    const { container, root, daemon } = await mountEditor(everyRecord, {
      session: { catalog: filterCatalog, machine },
    });
    const addFilter = buttonNamed(container, "Add filter");
    if (!addFilter) throw new Error("Add filter did not render");
    const menuItem = (text: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        ({ textContent }) => textContent === text,
      );

    await act(async () => addFilter.click());
    expect(menuItem("Issue is not blocked")).toBeUndefined();
    await act(async () => menuItem("Item is not blocked")?.click());
    const remove = () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Remove filter Item is not blocked"]');
    await eventually(() => expect(remove()).not.toBeNull());
    await act(async () => remove()?.click());

    await eventually(async () =>
      expect(
        (await daemon((probe) => probe.calls)).flatMap((call) => (call._tag === "edit" ? [call.edits] : [])),
      ).toEqual([
        [{ _tag: "AddTriggerFilter", trigger: "started", filter: { entry: "test.unblocked" } }],
        [{ _tag: "RemoveTriggerFilter", trigger: "started", entry: "test.unblocked" }],
      ]),
    );
    await act(async () => root.unmount());
  });

  it("saves a draft before the switch turns it on", async () => {
    Reflect.set(window, "cogwork", { notifications: { enable: async () => ({ _tag: "ready" }) } });
    const { container, root } = await mountEditor(record, { session: {} });
    const enable = container.querySelector<HTMLElement>('[aria-label="Turn this Workflow on"]');
    if (!enable) throw new Error("Switch did not render");

    await act(async () => enable.click());

    await eventually(() => expect(enable.getAttribute("aria-checked")).toBe("true"));
    Reflect.deleteProperty(window, "cogwork");
    await act(async () => root.unmount());
  });

  it("previews a pending edit before the catalog loads", async () => {
    const { container, root, daemon } = await mountEditor(everyRecord, { session: {} });
    await daemon((probe) => probe.holdReplies);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Workflow name"]');
    if (!input) throw new Error("Workflow name input did not render");

    input.focus();
    await typeInto(input, "Changed");
    await act(async () => input.blur());

    await eventually(() => expect(buttonNamed(container, "Save")?.disabled).toBe(false));
    await daemon((probe) => probe.releaseReplies);
    await act(async () => root.unmount());
  });

  it("shows Not saved when the daemon refuses an edit", async () => {
    const { container, root } = await mountEditor(everyRecord);
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove Work"]');
    if (!remove) throw new Error("Operation remove control did not render");

    await act(async () => remove.click());

    await eventually(() => expect(container.textContent).toContain("Not saved"));
    await act(async () => root.unmount());
  });

  it("shows why Save did not publish when another edit arrives first", async () => {
    const { container, root, daemon } = await mountEditor(record, { session: {} });
    await daemon((probe) => probe.holdReplies);

    await act(async () => buttonNamed(container, "Save")?.click());
    await daemon((probe) => probe.editAsAnotherAuthor(record.id, [{ _tag: "Rename", name: "Agent name" }]));
    await daemon((probe) => probe.releaseReplies);

    await eventually(() => expect(container.textContent).toContain("Another edit changed this Workflow"));
    await act(async () => root.unmount());
  });

  it("shows another author's change while an edit preview is pending", async () => {
    const { container, root, daemon } = await mountEditor(everyRecord);
    await daemon((probe) => probe.holdReplies);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Workflow name"]');
    if (!input) throw new Error("Workflow name input did not render");
    input.focus();
    await typeInto(input, "Changed");
    await act(async () => input.blur());

    await daemon((probe) => probe.seed({ ...everyRecord, enabled: true }));

    await eventually(() =>
      expect(
        container.querySelector('[aria-label="Turn this Workflow on"]')?.getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(buttonNamed(container, "Save")?.disabled).toBe(false);
    await daemon((probe) => probe.releaseReplies);
    await act(async () => root.unmount());
  });
});
