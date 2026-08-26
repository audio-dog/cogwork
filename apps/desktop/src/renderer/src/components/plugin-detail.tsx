// One Plugin's page.
//
// A Plugin is a collection of contributions and nothing more, so the page is its contributions
// grouped by kind — plus the three things that belong to the bundle rather than to any one
// contribution: where it came from, what it reaches, and whether an update is waiting on you.
//
// There is no Plugin on/off. Install and uninstall are the only Plugin-level states a person writes.

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@cogwork/ui/components/alert-dialog";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
import { Separator } from "@cogwork/ui/components/separator";
import { TooltipProvider } from "@cogwork/ui/components/tooltip";
import { RiArrowLeftSLine, RiBox3Line, RiCheckLine, RiDeleteBinLine, RiSubtractLine } from "@remixicon/react";
import { Link } from "@tanstack/react-router";
import {
  type Contribution,
  contributionKinds,
  type InstalledPlugin,
  kindLabelsPlural,
  type ReachDiff,
} from "../features/configuration-model";
import { contributionsOf, sourceLine } from "../features/plugins-view";
import { FidelityBadge, IdentityBadge, kindIcons, ReadinessBadge } from "./configuration-atoms";
import { ListRow, ListRows, ListSection } from "./customize-list";

/** Reach over what is currently on. Additions and drops sit beside it, without reach of their own. */
function StagedUpdate({ identity, reach }: { identity: string; reach: ReachDiff }) {
  return (
    <ListSection
      title="An update is staged"
      action={
        <>
          {/* The accept names the identity it accepts — not a bare confirmation. */}
          <Button size="sm">Accept {identity}</Button>
          <Button size="sm" variant="outline">
            Decline
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-3">
        <p className="text-sm text-muted-foreground">
          The bytes are written at a key nothing points at. Accepting repoints the install record; declining
          discards them and touches nothing.
        </p>

        {reach.changed.length === 0 ? (
          <p className="text-sm">Nothing this Plugin reaches has changed.</p>
        ) : (
          reach.changed.map((change) => (
            <div key={change.contributionId} className="flex flex-col rounded-md bg-background p-2">
              <span className="font-mono text-xs">{change.contributionId}</span>
              <span className="text-xs text-muted-foreground line-through">{change.before}</span>
              <span className="text-xs">{change.after}</span>
            </div>
          ))
        )}

        {reach.added.map((entry) => (
          <span key={entry.contributionId} className="font-mono text-xs text-muted-foreground">
            + {entry.contributionId} — new, and off until you turn it on
          </span>
        ))}
        {reach.dropped.map((entry) => (
          <span key={entry.contributionId} className="font-mono text-xs text-muted-foreground">
            − {entry.contributionId} — its setting is deleted at every place you own
          </span>
        ))}
      </div>
    </ListSection>
  );
}

function ContributionRow({ contribution }: { contribution: Contribution }) {
  const Icon = kindIcons[contribution.kind];
  const failed = contribution.load._tag === "failed";
  return (
    <ListRow
      icon={<Icon />}
      status={failed ? "error" : "ok"}
      title={contribution.localName}
      badge={contribution.readiness ? <ReadinessBadge readiness={contribution.readiness} /> : undefined}
      detail={
        failed && contribution.load._tag === "failed" ? (
          <span className="text-destructive">{contribution.load.reason}</span>
        ) : (
          contribution.summary
        )
      }
    />
  );
}

export function PluginDetail({ plugin }: { plugin: InstalledPlugin }) {
  const rows = contributionsOf(plugin);
  const remaining = plugin.setup.filter((step) => !step.done);

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-6">
        <Button variant="ghost" size="sm" className="w-fit" render={<Link to="/customize" />}>
          <RiArrowLeftSLine data-icon="inline-start" />
          Customize
        </Button>

        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-5">
              <RiBox3Line />
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <h1 className="font-heading text-2xl font-semibold tracking-tight">{plugin.name}</h1>
              <p className="text-sm text-muted-foreground">{plugin.summary}</p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger render={<Button size="sm" variant="ghost" />}>
                <RiDeleteBinLine data-icon="inline-start" />
                Uninstall
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogTitle>Uninstall {plugin.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This deletes its settings at every place you own — this machine and every private overlay. A
                  committed repository file is not yours to delete, so anything it wrote for this Plugin is
                  left in place and will dangle.
                </AlertDialogDescription>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep it</AlertDialogCancel>
                  <AlertDialogAction variant="destructive">Uninstall</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <IdentityBadge identity={plugin.record.resolvedIdentity} />
            <Separator orientation="vertical" className="h-4" />
            <span>{sourceLine(plugin)}</span>
            {plugin.requiredConnections.map((connection) => (
              // Names the requirement and nothing about the grant. A Plugin only offers.
              <Badge key={connection} variant="outline">
                Requires {connection}
              </Badge>
            ))}
          </div>
        </div>

        {plugin.update._tag === "staged" ? (
          <StagedUpdate identity={plugin.update.resolvedIdentity} reach={plugin.update.reach} />
        ) : null}

        {remaining.length > 0 ? (
          <ListSection title="Setup" count={remaining.length}>
            <ListRows>
              {plugin.setup.map((step) => (
                <ListRow
                  key={step.id}
                  icon={step.done ? <RiCheckLine /> : <RiSubtractLine />}
                  title={step.label}
                  detail={step.detail}
                  trailing={
                    step.done ? (
                      <Badge variant="ghost">Done</Badge>
                    ) : (
                      <Button size="sm" variant="outline">
                        Do it
                      </Button>
                    )
                  }
                />
              ))}
            </ListRows>
          </ListSection>
        ) : null}

        {contributionKinds.map((kind) => {
          const ofKind = rows.filter((contribution) => contribution.kind === kind);
          if (ofKind.length === 0) return null;
          return (
            <ListSection key={kind} title={kindLabelsPlural[kind]} count={ofKind.length}>
              <ListRows>
                {ofKind.map((contribution) => (
                  <ContributionRow key={contribution.id} contribution={contribution} />
                ))}
              </ListRows>
            </ListSection>
          );
        })}

        {rows.length === 0 ? (
          <Empty className="py-8">
            <EmptyHeader>
              <EmptyTitle>Nothing loaded</EmptyTitle>
              <EmptyDescription>
                This Plugin's manifest points at files, and none of them yielded a contribution.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        <ListSection title="What it reaches" count={plugin.permissions.length}>
          <div className="flex flex-col gap-2 p-3">
            {/* Derived from the bundle's files, never declared — a declared summary is a self-claim. */}
            <p className="text-sm text-muted-foreground">
              Computed from this bundle's files. Three postures are enforced exactly; anything finer is
              recorded as coarse and never presented as exact.
            </p>
            {plugin.permissions.map((row) => (
              <div key={row.label} className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm">{row.label}</span>
                  <span className="text-xs text-muted-foreground">{row.detail}</span>
                </span>
                <FidelityBadge fidelity={row.fidelity} />
              </div>
            ))}
          </div>
        </ListSection>

        {/* `pin` is on the install record and #135 found it has no semantics; #203 owns it. */}
        <p className="text-xs text-muted-foreground">
          No pin control. Every update is already an explicit, declinable act, so what `pin` would mean is
          undefined — #203 owns whether it survives.
        </p>
      </div>
    </TooltipProvider>
  );
}
