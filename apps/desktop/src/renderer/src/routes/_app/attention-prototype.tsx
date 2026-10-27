import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AttentionBoard } from "../../components/prototype-attention-board";
import { AttentionByWorkflow } from "../../components/prototype-attention-by-workflow";
import {
  CommandReadout,
  OsNotificationBanner,
  PrototypeControls,
} from "../../components/prototype-attention-chrome";
import { AttentionList } from "../../components/prototype-attention-list";
import { FocusProvider } from "../../components/prototype-attention-parts";
import { AttentionSplit } from "../../components/prototype-attention-split";
import { PrototypeSwitcher, type PrototypeVariant } from "../../components/prototype-switcher";

/**
 * PROTOTYPE — issue #794. Four layouts of the attention surface for Workflow parks, approvals,
 * notifications, and skipped work, switchable via `?variant=`, on mock data. `?focus=` names the
 * item an OS notification click opens.
 */

const variants: readonly PrototypeVariant[] = [
  { key: "A", name: "Board" },
  { key: "B", name: "List" },
  { key: "C", name: "Split" },
  { key: "D", name: "By Workflow" },
];

interface AttentionSearch {
  readonly variant: string;
  readonly focus?: string;
}

export const Route = createFileRoute("/_app/attention-prototype")({
  validateSearch: (search: Record<string, unknown>): AttentionSearch => ({
    variant: typeof search.variant === "string" ? search.variant : "A",
    focus: typeof search.focus === "string" ? search.focus : undefined,
  }),
  component: AttentionPrototypeRoute,
});

function Variant({ variant }: { variant: string }) {
  if (variant === "B") return <AttentionList />;
  if (variant === "C") return <AttentionSplit />;
  if (variant === "D") return <AttentionByWorkflow />;
  return <AttentionBoard />;
}

function AttentionPrototypeRoute() {
  const { variant, focus } = Route.useSearch();
  const navigate = useNavigate();
  const go = (next: Partial<AttentionSearch>) =>
    navigate({ to: "/attention-prototype", search: { variant, focus, ...next }, replace: true });
  const setFocus = (id: string | null) => go({ focus: id ?? undefined });

  return (
    <FocusProvider focus={focus ?? null} setFocus={setFocus}>
      <div className="flex h-full min-h-0 flex-col gap-4 pt-6 pb-20">
        <h1 className="px-6 font-heading text-2xl font-semibold tracking-tight">Attention</h1>
        <div className="min-h-0 flex-1">
          <Variant variant={variant} />
        </div>
      </div>
      <OsNotificationBanner onOpen={setFocus} />
      <CommandReadout />
      <PrototypeSwitcher variants={variants} current={variant} onSelect={(key) => go({ variant: key })}>
        <PrototypeControls />
      </PrototypeSwitcher>
    </FocusProvider>
  );
}
