// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BufferedInput } from "./buffered-field";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("BufferedInput", () => {
  it("saves once on blur, even after the typing pause ends", async () => {
    vi.useFakeTimers();
    const saved: Array<string> = [];
    const save = async (text: string) => {
      saved.push(text);
      return text.trim();
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => root.render(<BufferedInput value="Old" label="Name" save={save} />));
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Name"]');
    if (!input) throw new Error("Name input did not render");

    input.focus();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Triage ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.blur());
    await act(() => vi.advanceTimersByTimeAsync(600));

    expect(saved).toEqual(["Triage "]);
    await act(async () => root.unmount());
  });
});
