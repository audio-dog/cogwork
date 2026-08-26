import { Card } from "@cogwork/ui/components/card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@cogwork/ui/components/input-group";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@cogwork/ui/components/item";
import { cn } from "@cogwork/ui/lib/utils";
import { RiAddLine, RiSubtractLine } from "@remixicon/react";
import { createContext, type ReactNode, use, useRef, useState } from "react";
import type { SettingEntry } from "../features/settings-catalog";
import { parseCount, sanitizeCountDraft } from "../features/settings-values";

const FocusedSettingContext = createContext<{ focus?: string; jump?: number }>({});

/**
 * Mounted on the `/settings` layout route, so `focus` and `jump` are validated and read once for
 * every section rather than repeated on each of them.
 */
export function SettingsFocusProvider({
  focus,
  jump,
  children,
}: {
  focus?: string;
  jump?: number;
  children: ReactNode;
}) {
  return <FocusedSettingContext value={{ focus, jump }}>{children}</FocusedSettingContext>;
}

export function useFocusFlash(id: string) {
  const { focus, jump } = use(FocusedSettingContext);
  const flashing = focus === id;
  // Changing the key on each jump remounts the node so the CSS flash animation replays.
  const flashKey = flashing ? `${id}:${jump ?? 0}` : id;
  const scrolledNode = useRef<HTMLElement | null>(null);

  // The guard lives entirely in the ref callback (commit time) and never reads
  // or writes `ref.current` during render. Each activation remounts the keyed
  // node, so a fresh node means "scroll again": this re-scrolls when the same
  // setting + jump is focused a second time (deep-link or back), while a node
  // that stays mounted across re-renders is scrolled only once.
  const ref = (node: HTMLElement | null) => {
    if (!node || !flashing || scrolledNode.current === node) return;
    scrolledNode.current = node;
    node.scrollIntoView({ block: "center" });
  };

  return { ref, flashing, flashKey };
}

export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-8">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">{title}</h1>
      {children}
    </div>
  );
}

export function SettingRow({ entry, children }: { entry: SettingEntry; children: ReactNode }) {
  const { ref, flashing, flashKey } = useFocusFlash(entry.id);
  return (
    <Item
      key={flashKey}
      ref={ref}
      className={cn("scroll-mt-8 rounded-lg", flashing && "settings-focus-flash")}
    >
      <ItemContent>
        <ItemTitle>{entry.title}</ItemTitle>
        <ItemDescription>{entry.description}</ItemDescription>
      </ItemContent>
      <ItemActions>{children}</ItemActions>
    </Item>
  );
}

export function SubSectionCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">{label}</h2>
      <Card size="sm" className="gap-0 py-0">
        {children}
      </Card>
    </section>
  );
}

export function NumberStepper({
  value,
  min,
  max,
  label,
  disabled,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const commit = (next: number) => {
    setEditing(false);
    const clamped = Math.min(max, Math.max(min, next));
    if (clamped !== value) onChange(clamped);
  };
  return (
    <InputGroup className="w-28">
      <InputGroupInput
        aria-label={label}
        inputMode="numeric"
        disabled={disabled}
        value={editing ? draft : String(value)}
        onFocus={() => {
          setDraft(String(value));
          setEditing(true);
        }}
        onBlur={() => commit(parseCount(draft, min))}
        onChange={(event) => setDraft(sanitizeCountDraft(event.target.value))}
        className="text-center tabular-nums"
      />
      <InputGroupAddon>
        <InputGroupButton
          size="icon-xs"
          disabled={disabled}
          aria-label={`Decrease ${label}`}
          onClick={() => commit(Math.max(min, value - 1))}
        >
          <RiSubtractLine />
        </InputGroupButton>
      </InputGroupAddon>
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          disabled={disabled}
          aria-label={`Increase ${label}`}
          onClick={() => commit(value + 1)}
        >
          <RiAddLine />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
