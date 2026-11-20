import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@cogwork/ui/components/dialog";
import { RiLoopLeftLine, RiServerLine } from "@remixicon/react";
import type { ReactNode } from "react";

import { scopeIcons } from "../features/configuration-icons";
import {
  authorityLabel,
  type Contribution as ContributionRecord,
  LoadState,
  McpReadiness,
  scopeCopy,
} from "../features/configuration-model";
import { offeredElsewhere } from "../features/configuration-resolve";
import { useConfiguration } from "./configuration-provider";
import { Contribution, useContribution } from "./contribution";

/**
 * `DialogContent` styles its popup as a `grid`, and a grid item's default `min-width: auto` means
 * min-content — so one unbreakable string, like a long file path, sets a floor the item cannot
 * shrink below and it overflows the dialog. Every direct child of the popup needs `min-w-0`, and
 * `truncate` needs that chain unbroken to work at all.
 */
function DialogSection({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-1.5">{children}</div>;
}

function DialogSectionTitle({ children }: { children: ReactNode }) {
  return <span className="text-sm font-medium">{children}</span>;
}

function DialogSectionHint({ children }: { children: ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>;
}

function DialogSectionBody({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-lg bg-muted/40">
      {children}
    </div>
  );
}

function SourceSection() {
  const {
    state: { contribution },
    meta: { target },
  } = useContribution();
  const {
    meta: { workspaceById },
  } = useConfiguration();
  const workspace = workspaceById(contribution.definedIn);
  const PlaceIcon = scopeIcons[contribution.definedAt];

  return (
    <DialogSection>
      <DialogSectionTitle>Source</DialogSectionTitle>
      <DialogSectionHint>Where this server is configured, and whether it is on.</DialogSectionHint>
      <DialogSectionBody>
        <div className="flex min-w-0 items-center gap-2.5 px-3 py-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground [&_svg]:size-4">
            <PlaceIcon />
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm">
              {workspace ? `${workspace.name} · ` : ""}
              {scopeCopy[contribution.definedAt].name}
            </span>
            <span className="truncate font-mono text-xs text-muted-foreground">{contribution.file}</span>
          </span>
          <Badge variant="outline" className="shrink-0">
            {authorityLabel(contribution.authority)}
          </Badge>
          <Contribution.Switch label={`Turn ${contribution.localName} on`} />
        </div>
        {offeredElsewhere(contribution) && target ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            The repo ships this file but can't start a process on your machine, so the switch writes to{" "}
            {scopeCopy[target.kind].name}.
          </p>
        ) : null}
      </DialogSectionBody>
    </DialogSection>
  );
}

/**
 * The Engine reports ready or not ready — or nothing at all, when it never got far enough to judge.
 * A file that will not load is the third case, and calling it either of the first two is a lie.
 */
export function readinessCopy(contribution: ContributionRecord) {
  if (McpReadiness.$is("ready")(contribution.readiness)) {
    return {
      title: "Ready",
      detail: "Launchable, authenticated, and speaking a protocol we understand.",
      output: false,
    };
  }
  if (McpReadiness.$is("not-ready")(contribution.readiness)) {
    return { title: "Not ready", detail: contribution.readiness.reason, output: true };
  }
  if (LoadState.$is("failed")(contribution.load)) {
    return {
      title: "Not checked",
      detail: "This file didn't load, so the Engine never started the server to judge it.",
      output: true,
    };
  }
  return { title: "Not checked", detail: "The Engine hasn't reached a conclusion yet.", output: false };
}

function StatusSection() {
  const {
    state: { contribution },
  } = useContribution();
  const { title, detail, output } = readinessCopy(contribution);

  return (
    <DialogSection>
      <DialogSectionTitle>Status</DialogSectionTitle>
      <DialogSectionHint>The Engine's own conclusion. Nothing here is yours to set.</DialogSectionHint>
      <DialogSectionBody>
        <div className="flex min-w-0 items-center gap-2.5 px-3 py-2.5">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm">{title}</span>
            <span className="text-xs text-muted-foreground">{detail}</span>
          </span>
          {output ? (
            <Button size="sm" variant="ghost">
              Show output
            </Button>
          ) : null}
        </div>
      </DialogSectionBody>
    </DialogSection>
  );
}

function NamesakeNote() {
  const {
    state: { contribution },
  } = useContribution();
  const {
    state: { picture },
  } = useConfiguration();

  const namesake = picture.contributions.find(
    (entry) =>
      entry.kind === "mcp-server" &&
      entry.localName === contribution.localName &&
      entry.id !== contribution.id,
  );
  if (!namesake) return null;

  return (
    <p className="min-w-0 text-xs break-words text-muted-foreground">
      Another server is also called <span className="font-medium">{contribution.localName}</span> —{" "}
      <span className="font-mono">{namesake.id}</span>. They are separate servers with the same name, and
      cogwork keeps them apart rather than merging them.
    </p>
  );
}

export function McpConfigureDialog() {
  const {
    state: { contribution, diagnostics },
  } = useContribution();

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader className="min-w-0">
        <DialogTitle className="flex min-w-0 items-center gap-2 pe-8">
          <span className="flex size-7 items-center justify-center rounded-md bg-muted [&_svg]:size-4">
            <RiServerLine />
          </span>
          Configure {contribution.localName}
        </DialogTitle>
        <DialogDescription>{contribution.summary}</DialogDescription>
      </DialogHeader>

      <SourceSection />
      <StatusSection />
      <NamesakeNote />

      {diagnostics.length > 0 ? (
        <p className="min-w-0 text-xs break-words text-destructive">{diagnostics[0].diagnostic.detail}</p>
      ) : null}

      <DialogFooter className="min-w-0 justify-between sm:justify-between">
        <Button size="sm" variant="ghost">
          <RiLoopLeftLine data-icon="inline-start" />
          Check again
        </Button>
        <DialogClose render={<Button size="sm" />}>Done</DialogClose>
      </DialogFooter>
    </DialogContent>
  );
}
