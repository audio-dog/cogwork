// Configuring one MCP server.
//
// A dialog rather than a page, because an MCP server has two things to say and they are both short:
// where it is configured, and whether the Engine can reach it. Cursor calls the second half
// "Environments"; ours is readiness, which is the Engine's own conclusion and not something a person
// edits — so it is reported with a way to look at the output, and a way to ask again.
//
// The one thing a person changes here is the switch, which is the same act as the switch on the row.

import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@cogwork/ui/components/dialog";
import { Switch } from "@cogwork/ui/components/switch";
import { RiLoopLeftLine, RiServerLine } from "@remixicon/react";
import type { ReactNode } from "react";
import { draftCellAt, withDraft } from "../features/configuration-draft";
import { authorityLabel, type Contribution, scopeCopy } from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import { enableScopeFor, offeredElsewhere, resolveEnablement } from "../features/configuration-resolve";
import { useConfigurationDraftStore } from "../store/configuration-draft";
import { scopeIcons } from "./configuration-atoms";

const { contributions, workspaces } = placeholderConfiguration;

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{title}</span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-lg bg-muted/40">
        {children}
      </div>
    </div>
  );
}

export function McpConfigureDialog({
  contribution,
  open,
  onOpenChange,
}: {
  contribution: Contribution;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  const setCell = useConfigurationDraftStore((state) => state.setCell);

  const view = { workspaceId: contribution.definedIn };
  const edited = withDraft(contribution, cells);
  const resolved = resolveEnablement(edited, view);
  const target = enableScopeFor(contribution);
  const on = target ? draftCellAt(contribution, target, cells) === "on" : resolved.effective === true;

  const workspace = workspaces.find((entry) => entry.id === contribution.definedIn);
  const PlaceIcon = scopeIcons[contribution.definedAt];

  // Identity carries Authority, so two servers with one local name are two different things and
  // cogwork never reconciles them. Saying so is the only honest way to render the collision.
  const namesakes = contributions.filter(
    (entry) =>
      entry.kind === "mcp-server" &&
      entry.localName === contribution.localName &&
      entry.id !== contribution.id,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-md bg-muted [&_svg]:size-4">
              <RiServerLine />
            </span>
            Configure {contribution.localName}
          </DialogTitle>
          <DialogDescription>{contribution.summary}</DialogDescription>
        </DialogHeader>

        <Section title="Source" hint="Where this server is configured, and whether it is on.">
          <div className="flex items-center gap-2.5 px-3 py-2.5">
            <span className="flex size-7 items-center justify-center rounded-md bg-background text-muted-foreground [&_svg]:size-4">
              <PlaceIcon />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm">
                {workspace ? `${workspace.name} · ` : ""}
                {scopeCopy[contribution.definedAt].name}
              </span>
              <span className="truncate font-mono text-xs text-muted-foreground">{contribution.file}</span>
            </span>
            <Badge variant="outline">{authorityLabel(contribution.authority)}</Badge>
            <Switch
              checked={on}
              disabled={target === undefined}
              onCheckedChange={(checked) => {
                if (target) setCell(contribution.id, target, checked ? "on" : "off");
              }}
            />
          </div>
          {offeredElsewhere(contribution) && target ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              The repo ships this file but can't start a process on your machine, so the switch writes to{" "}
              {scopeCopy[target.kind].name}.
            </p>
          ) : null}
        </Section>

        <Section title="Status" hint="The Engine's own conclusion. Nothing here is yours to set.">
          <div className="flex items-center gap-2.5 px-3 py-2.5">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm">
                {contribution.readiness?._tag === "ready" ? "Ready" : "Not ready"}
              </span>
              <span className="text-xs text-muted-foreground">
                {contribution.readiness?._tag === "not-ready"
                  ? contribution.readiness.reason
                  : "Launchable, authenticated, and speaking a protocol we understand."}
              </span>
            </span>
            {contribution.readiness?._tag === "not-ready" ? (
              <Button size="sm" variant="ghost">
                Show output
              </Button>
            ) : null}
          </div>
        </Section>

        {namesakes.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Another server is also called <span className="font-medium">{contribution.localName}</span> —{" "}
            <span className="font-mono">{namesakes[0].id}</span>. They are separate servers with the same
            name, and cogwork keeps them apart rather than merging them.
          </p>
        ) : null}

        {resolved.dropped.length > 0 ? (
          <p className="text-xs text-destructive">{resolved.dropped[0].diagnostic.detail}</p>
        ) : null}

        <DialogFooter className="justify-between sm:justify-between">
          <Button size="sm" variant="ghost">
            <RiLoopLeftLine data-icon="inline-start" />
            Check again
          </Button>
          <DialogClose render={<Button size="sm" />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
