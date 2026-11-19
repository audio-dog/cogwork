// @vitest-environment happy-dom

import {
  MachineReadiness,
  PrincipalId,
  WorkflowCatalog,
  WorkflowDocument,
  WorkflowId,
  type WorkflowOption,
  type WorkflowRecord,
  WorkspaceId,
} from "@cogwork/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { act, type KeyboardEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowEditor } from "../components/workflow-editor";
import { WorkflowsList } from "../components/workflows-list";
import { openTestWorkingCopies } from "../testing/working-copies";
import { importReviewMark } from "./workflow-import-review";
import {
  type WorkflowClient,
  WorkflowProvider,
  type WorkflowSessionState,
  workflowProviderValue,
} from "./workflow-session";
import { exportWorkflow, importWorkflow } from "./workflow-transfer";
import { type ListWorkflowOptions, WorkingCopiesProvider } from "./working-copy-provider";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const navigate = vi.hoisted(() => vi.fn(async (_destination: unknown) => undefined));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    to,
    params,
    onClick,
    onKeyDown,
    "aria-label": ariaLabel,
  }: {
    readonly children?: ReactNode;
    readonly to?: string;
    readonly params?: { readonly workflowId?: string };
    readonly onClick?: (event: { readonly defaultPrevented: boolean }) => void;
    readonly onKeyDown?: (event: KeyboardEvent<HTMLAnchorElement>) => void;
    readonly "aria-label"?: string;
  }) => (
    <a
      href={to ?? "/workflows"}
      aria-label={ariaLabel}
      onClick={async (event) => {
        onClick?.(event);
        if (event.defaultPrevented || to !== "/workflows/$workflowId" || !params?.workflowId) return;
        await navigate({ to, params: { workflowId: params.workflowId } });
      }}
      onKeyDown={onKeyDown}
    >
      {children}
    </a>
  ),
  useNavigate: () => navigate,
}));

const decodeWorkflowId = Schema.decodeUnknownSync(WorkflowId);
const decodePrincipalId = Schema.decodeUnknownSync(PrincipalId);
const decodeWorkspaceId = Schema.decodeUnknownSync(WorkspaceId);
const decodeDocument = Schema.decodeUnknownSync(WorkflowDocument);
const decodeCatalog = Schema.decodeUnknownSync(WorkflowCatalog);
const decodeMachine = Schema.decodeUnknownSync(MachineReadiness);

const workflowDocument = decodeDocument({
  name: "Local name",
  workspaces: { _tag: "Listed", workspaces: [decodeWorkspaceId("cogwork")] },
  triggers: [],
  operations: [],
});

const record: WorkflowRecord = {
  id: decodeWorkflowId("workflow-1"),
  principal: decodePrincipalId("person"),
  workingCopy: workflowDocument,
  workingRevision: 1,
  publishedCopy: null,
  publishedRevision: null,
  enabled: false,
  diagnostics: [],
  readiness: [],
};

const everyDocument = decodeDocument({
  name: "Every workspace",
  workspaces: { _tag: "Every" },
  triggers: [
    {
      id: "started",
      entry: "test.started",
      parameters: [{ id: "target", value: "" }],
      start: "work",
    },
  ],
  operations: [
    {
      id: "work",
      name: "Work",
      instructionPackage: null,
      instruction: "Do the work.",
      permissionProfile: "read-only",
      requires: [],
      model: { harness: "codex", model: "gpt-5", options: [] },
      forEach: null,
      questions: [{ id: "outcome", text: "Done?", choices: [{ id: "yes", name: "Yes" }] }],
      transitions: [
        {
          when: [{ question: "outcome", choice: "yes" }],
          actions: [{ entry: "test.done", parameters: [] }],
          handOff: null,
        },
      ],
      hints: [],
    },
  ],
});

const catalog = decodeCatalog({
  entries: [
    {
      key: "test.started",
      name: "Started",
      kind: "trigger",
      system: null,
      connection: null,
      requires: [],
      parameters: [{ id: "target", required: false, source: "live", values: [] }],
      itemKind: null,
      actsOn: [],
      requiresWorkspace: true,
      workspaceSource: null,
      permissionProfile: "read-only",
      agentInputs: [],
      emits: [],
    },
    {
      key: "test.done",
      name: "Done",
      kind: "action",
      system: null,
      connection: null,
      requires: [],
      parameters: [{ id: "target", required: false, source: "live", values: [] }],
      itemKind: null,
      actsOn: [],
      requiresWorkspace: true,
      workspaceSource: "agent",
      permissionProfile: "read-only",
      agentInputs: [],
      emits: [],
    },
  ],
  instructionPackages: [],
  harnesses: [{ name: "codex", models: [{ id: "gpt-5", options: [] }] }],
});

const filterEntry = (key: string, name: string, system: string | null) => ({
  key,
  name,
  kind: "filter",
  system,
  connection: null,
  requires: [],
  parameters: [],
  itemKind: null,
  actsOn: [],
  requiresWorkspace: true,
  workspaceSource: null,
  permissionProfile: "read-only",
  agentInputs: [],
  emits: [],
});

const filterCatalog = decodeCatalog({
  ...catalog,
  entries: [
    ...catalog.entries,
    filterEntry("test.unblocked", "Item is not blocked", null),
    filterEntry("github.issue-not-blocked", "Issue is not blocked", "github"),
  ],
});

const machine = decodeMachine({
  workspaces: [
    { id: "first", binds: [] },
    { id: "second", binds: [] },
  ],
  connections: [],
  harnesses: [{ name: "codex", available: true }],
  defaultHarness: "codex",
  readyNeeds: [],
});

const sessionState = (
  workflows: ReadonlyArray<WorkflowRecord>,
  overrides: Partial<WorkflowSessionState> = {},
): WorkflowSessionState => ({
  workflows,
  catalog: null,
  machine: null,
  workspaceLabels: new Map(),
  templates: [],
  harnesses: { catalogs: null, readiness: null, controlStore: null },
  needs: [],
  loading: false,
  ...overrides,
});

const everyRecord: WorkflowRecord = {
  ...record,
  workingCopy: everyDocument,
  publishedCopy: everyDocument,
  publishedRevision: 1,
};

const transitionDocument = decodeDocument({
  ...everyDocument,
  operations: everyDocument.operations.map((operation) => ({
    ...operation,
    questions: [
      {
        id: "outcome",
        text: "Done?",
        choices: [
          { id: "yes", name: "Yes" },
          { id: "no", name: "No" },
        ],
      },
    ],
    transitions: [
      {
        when: [{ question: "outcome", choice: "yes" }],
        actions: [{ entry: "test.done", parameters: [{ id: "target", value: "first" }] }],
        handOff: null,
      },
      {
        when: [{ question: "outcome", choice: "no" }],
        actions: [{ entry: "test.done", parameters: [{ id: "target", value: "second" }] }],
        handOff: null,
      },
    ],
  })),
});

const transitionRecord: WorkflowRecord = {
  ...everyRecord,
  workingCopy: transitionDocument,
  publishedCopy: transitionDocument,
};

const unused = async () => {
  throw new Error("unexpected call");
};

const sessionClient: WorkflowClient = { create: unused, switchEnabled: unused, delete: unused };

const listFrom =
  (
    fake: (...args: Parameters<ListWorkflowOptions>) => Promise<ReadonlyArray<WorkflowOption>>,
  ): ListWorkflowOptions =>
  (...args) =>
    Effect.promise(() => fake(...args));

const disposers: Array<() => Promise<void>> = [];

const mountEditor = async (
  workflow: WorkflowRecord,
  {
    session = { catalog, machine },
    listOptions,
    importReview,
    onPublished,
  }: {
    readonly session?: Partial<WorkflowSessionState>;
    readonly listOptions?: ListWorkflowOptions;
    readonly importReview?: ReadonlyArray<string>;
    readonly onPublished?: () => void;
  } = {},
) => {
  const copies = await openTestWorkingCopies([workflow], listOptions);
  disposers.push(copies.dispose);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <WorkflowProvider value={workflowProviderValue(sessionState([workflow], session), sessionClient)}>
        <WorkingCopiesProvider client={copies.client}>
          <WorkflowEditor workflow={workflow} importReview={importReview} onPublished={onPublished} />
        </WorkingCopiesProvider>
      </WorkflowProvider>,
    );
  });
  return { container, root, daemon: copies.daemon };
};

const eventually = (assertion: () => void | Promise<void>) =>
  vi.waitFor(async () => {
    await act(() => Effect.runPromise(Effect.yieldNow));
    await assertion();
  });

const typeInto = (input: HTMLInputElement, text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

const buttonNamed = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find(({ textContent }) => textContent === text);

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

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

  it("keeps the list on/off control disabled until the Workflow is published", async () => {
    const switchEnabled = vi.fn<WorkflowClient["switchEnabled"]>(async () => record);
    const copies = await openTestWorkingCopies([record]);
    disposers.push(copies.dispose);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <WorkflowProvider
          value={workflowProviderValue(sessionState([record]), { ...sessionClient, switchEnabled })}
        >
          <WorkingCopiesProvider client={copies.client}>
            <WorkflowEditor workflow={record} />
          </WorkingCopiesProvider>
          <WorkflowsList />
        </WorkflowProvider>,
      );
    });
    navigate.mockClear();

    const card = [...container.querySelectorAll<HTMLElement>("[data-slot=card]")].find((element) =>
      element.textContent?.includes("Local name"),
    );
    if (!card) throw new Error("Workflow card did not render");
    const toggle = [...card.querySelectorAll("button")].find((button) => button.textContent === "Off");
    const exportWorkflow = card.querySelector<HTMLButtonElement>('button[aria-label="Export Local name"]');
    const opener = card.querySelector<HTMLAnchorElement>("a");
    if (!toggle) throw new Error("On/Off control did not render");
    if (!exportWorkflow) throw new Error("Export control did not render");
    if (!opener) throw new Error("Workflow card did not open");

    expect(card.querySelector('[role="switch"]')).toBeNull();
    expect(opener.querySelector("button")).toBeNull();
    expect(toggle.closest("a")).toBeNull();
    expect(exportWorkflow.closest("a")).toBeNull();
    expect(toggle.disabled).toBe(true);
    await act(async () => {
      toggle.click();
      exportWorkflow.click();
    });
    expect(switchEnabled).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => {
      opener.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigate).toHaveBeenCalledWith({
      to: "/workflows/$workflowId",
      params: { workflowId: record.id },
    });
    await act(async () => root.unmount());
  });

  it("shows an import failure on the list and does not create a workflow", async () => {
    const create = vi.fn<WorkflowClient["create"]>(unused);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <WorkflowProvider value={workflowProviderValue(sessionState([record]), { ...sessionClient, create })}>
          <WorkflowsList />
        </WorkflowProvider>,
      );
    });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("Import input did not render");
    const transfer = new DataTransfer();
    transfer.items.add(new File(["{"], "broken.json", { type: "application/json" }));
    input.files = transfer.files;

    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    expect(create).not.toHaveBeenCalled();
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      Effect.runSync(
        importWorkflow("{").pipe(
          Effect.match({
            onFailure: (error) => error.message,
            onSuccess: () => {
              throw new Error("invalid JSON imported");
            },
          }),
        ),
      ),
    );
    await act(async () => root.unmount());
  });

  it("imports a workflow file dropped on the list", async () => {
    const imported = { ...record, id: decodeWorkflowId("workflow-imported") };
    const create = vi.fn<WorkflowClient["create"]>(async () => imported);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <WorkflowProvider value={workflowProviderValue(sessionState([record]), { ...sessionClient, create })}>
          <WorkflowsList />
        </WorkflowProvider>,
      );
    });
    navigate.mockClear();
    const view = container.firstElementChild;
    if (!(view instanceof HTMLElement)) throw new Error("Workflow list did not render");
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([exportWorkflow(workflowDocument)], "local-name.json", { type: "application/json" }),
    );
    const drop = new DragEvent("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: transfer });

    await act(async () => {
      view.dispatchEvent(drop);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(create).toHaveBeenCalledWith(workflowDocument);
    expect(navigate).toHaveBeenCalledWith({
      to: "/workflows/$workflowId/review",
      params: { workflowId: imported.id },
    });
    await act(async () => root.unmount());
  });

  it("highlights imported fields until they are saved and then leaves the review", async () => {
    const operation = everyDocument.operations[0];
    if (!operation) throw new Error("expected an operation");
    const draft = { ...everyRecord, publishedCopy: null, publishedRevision: null };
    const onPublished = vi.fn<() => void>();
    const { container, root } = await mountEditor(draft, {
      session: { catalog },
      importReview: [importReviewMark.workspaces, importReviewMark.model(operation.id)],
      onPublished,
    });

    expect(container.textContent).toContain("Review these before you turn this on");
    expect(container.querySelector(`[data-import-review="${importReviewMark.workspaces}"]`)).not.toBeNull();
    expect(
      container.querySelector(`[data-import-review="${importReviewMark.model(operation.id)}"]`),
    ).not.toBeNull();

    const workspaces = container.querySelector<HTMLButtonElement>('[aria-label="Workspaces"]');
    if (!workspaces) throw new Error("Workspace menu did not render");
    await act(async () => workspaces.click());
    const noWorkspace = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
      option.textContent?.includes("No workspace"),
    );
    if (!noWorkspace) throw new Error("No workspace was not offered");
    await act(async () => noWorkspace.click());

    expect(container.querySelector(`[data-import-review="${importReviewMark.workspaces}"]`)).toBeNull();
    expect(
      container.querySelector(`[data-import-review="${importReviewMark.model(operation.id)}"]`),
    ).not.toBeNull();
    expect(container.textContent).toContain("Review these before you turn this on");

    await act(async () => buttonNamed(container, "Save")?.click());

    await eventually(() => expect(onPublished).toHaveBeenCalledTimes(1));
    await act(async () => root.unmount());
  });

  it("lists same-code problems with distinct identities", async () => {
    const duplicateLocation = {
      trigger: null,
      operation: null,
      question: null,
      choice: null,
      field: "workflow",
    };
    const workflow: WorkflowRecord = {
      ...record,
      diagnostics: [
        {
          code: "no-trigger",
          class: "incomplete",
          location: duplicateLocation,
          message: "Add a trigger",
        },
      ],
      readiness: [
        {
          code: "no-trigger",
          class: "advisory",
          location: duplicateLocation,
          message: "No trigger is ready",
        },
      ],
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container, root } = await mountEditor(workflow);
    const problems = container.querySelector<HTMLButtonElement>('[aria-label="2 problems"]');
    if (!problems) throw new Error("Problems button did not render");
    await act(async () => problems.click());

    expect(document.body.textContent).toContain("Add a trigger");
    expect(document.body.textContent).toContain("No trigger is ready");
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("same key");
    await act(async () => root.unmount());
  });

  it("blocks Save for an incomplete problem and never for an advisory one", async () => {
    const location = { trigger: null, operation: null, question: null, choice: null, field: "document" };
    const advisory: WorkflowRecord = {
      ...everyRecord,
      workingRevision: 2,
      readiness: [
        { code: "harness-unavailable", class: "advisory", location, message: "Harness codex is unavailable" },
      ],
    };
    const incomplete: WorkflowRecord = {
      ...advisory,
      diagnostics: [
        { code: "no-trigger", class: "incomplete", location, message: "Workflow has no Trigger" },
      ],
    };
    const { container, root, daemon } = await mountEditor(advisory);

    expect(buttonNamed(container, "Save")?.disabled).toBe(false);
    await daemon((probe) => probe.seed(incomplete));
    await eventually(() => expect(buttonNamed(container, "Save")?.disabled).toBe(true));
    await act(async () => root.unmount());
  });

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
