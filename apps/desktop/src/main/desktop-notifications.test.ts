import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopNotifications,
  type DesktopNotificationHandle,
  notificationIdFromActivation,
} from "./desktop-notifications";

class FakeNotification extends EventEmitter implements DesktopNotificationHandle {
  readonly close = vi.fn();
  readonly show = vi.fn();

  constructor(
    readonly id: string,
    readonly title: string,
    readonly body: string,
  ) {
    super();
  }
}

const request = (id: string, focus = id) => ({
  id,
  focus,
  title: `${id} needs you`,
  body: "Review the parked item",
});

const setup = (history: readonly FakeNotification[] = [], launchIdentifier: string | null = null) => {
  const created: FakeNotification[] = [];
  const navigated: string[] = [];
  const statuses: string[] = [];
  const deps = {
    create: (options: { readonly id: string; readonly title: string; readonly body: string }) => {
      const notification = new FakeNotification(options.id, options.title, options.body);
      created.push(notification);
      return notification;
    },
    getHistory: vi.fn(async () => history),
    isSupported: vi.fn(() => true),
    remove: vi.fn(),
    registerActivation: vi.fn(),
    showWindow: vi.fn(),
    navigate: (id: string) => navigated.push(id),
    publishStatus: (status: { readonly _tag: string }) => statuses.push(status._tag),
    logFailure: vi.fn(),
    openSettings: vi.fn(async () => true),
    launchIdentifier,
  };
  return {
    service: createDesktopNotifications(deps),
    deps,
    created,
    navigated,
    statuses,
  };
};

describe("desktop notifications", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not touch Electron Notification before notifications are enabled", async () => {
    const { service, deps, created } = setup();

    await service.sync([request("issue:acme:818")]);

    expect(deps.isSupported).not.toHaveBeenCalled();
    expect(deps.getHistory).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it("recovers the notification id from Windows activation arguments", () => {
    expect(notificationIdFromActivation("type=click&tag=issue%3Aacme%3A818")).toBe("issue:acme:818");
    expect(notificationIdFromActivation("issue:acme:818")).toBe("issue:acme:818");
  });

  it("restores history and creates one live notification for each new park", async () => {
    const restored = new FakeNotification("issue:acme:817", "Existing", "Already delivered");
    const { service, deps, created } = setup([restored]);

    await service.enable();
    await service.sync([request("issue:acme:817"), request("issue:acme:818")]);
    await service.sync([request("issue:acme:817"), request("issue:acme:818")]);

    expect(deps.getHistory).toHaveBeenCalledOnce();
    expect(created.map(({ id }) => id)).toEqual(["issue:acme:818"]);
    expect(created[0]?.show).toHaveBeenCalledOnce();
  });

  it("closes a delivered notification when its park leaves the read model", async () => {
    const { service, created } = setup();
    await service.enable();
    await service.sync([request("issue:acme:818")]);

    await service.sync([]);

    expect(created[0]?.close).toHaveBeenCalledOnce();
    expect(created[0]?.listenerCount("click")).toBe(0);
  });

  it("deduplicates notification ids before creating native handles", async () => {
    const { service, created } = setup();
    await service.enable();

    await service.sync([request("issue:acme:818"), request("issue:acme:818")]);

    expect(created).toHaveLength(1);
  });

  it("shows the window and routes clicks only after the read model confirms the item", async () => {
    const { service, deps, created, navigated } = setup();
    await service.enable();
    await service.sync([request("issue:acme:818")]);

    created[0]?.emit("click", {});

    expect(deps.showWindow).toHaveBeenCalledOnce();
    expect(navigated).toEqual(["issue:acme:818"]);
  });

  it.each([
    ["cogwork://attention?focus=issue%3Aacme%3A818", ["issue:acme:818"]],
    ["cogwork://attention?focus=issue%3Aacme%3A999", []],
    ["cogwork://settings?focus=issue%3Aacme%3A818", []],
    ["cogwork://attention?focus=", []],
    ["cogwork://attention?focus=issue%3Aacme%3A818&extra=true", []],
  ])("accepts only a known attention URL: %s", async (url, expected) => {
    const { service, deps, navigated } = setup();
    await service.enable();

    service.openUrl(url);
    await service.sync([request("issue:acme:818")]);

    expect(deps.showWindow).toHaveBeenCalledOnce();
    expect(navigated).toEqual(expected);
  });

  it("uses the ready launch notification after the read model confirms it", async () => {
    const { service, navigated } = setup([], "issue:acme:818");

    await service.enable();
    await service.sync([request("issue:acme:818")]);

    expect(navigated).toEqual(["issue:acme:818"]);
  });

  it("keeps valid launch input when a later candidate is unknown", async () => {
    const { service, navigated } = setup();
    await service.enable();
    service.openUrl("cogwork://attention?focus=issue%3Aacme%3A818");
    service.openUrl("cogwork://attention?focus=issue%3Aacme%3A999");

    await service.sync([request("issue:acme:818")]);

    expect(navigated).toEqual(["issue:acme:818"]);
  });

  it("routes known items when OS notification delivery is unsupported", async () => {
    const { service, deps, navigated } = setup();
    deps.isSupported.mockReturnValue(false);
    service.openUrl("cogwork://attention?focus=issue%3Aacme%3A818");
    await service.enable();

    await service.sync([request("issue:acme:818")]);

    expect(navigated).toEqual(["issue:acme:818"]);
  });

  it("logs and publishes a failed status without removing the park", async () => {
    const { service, deps, created, statuses } = setup();
    await service.enable();
    await service.sync([request("issue:acme:818")]);

    created[0]?.emit("failed", {}, "Notifications are not allowed");
    await service.sync([request("issue:acme:818")]);

    expect(deps.logFailure).toHaveBeenCalledWith("Notifications are not allowed");
    expect(statuses.at(-1)).toBe("failed");
    expect(created).toHaveLength(1);
  });
});
