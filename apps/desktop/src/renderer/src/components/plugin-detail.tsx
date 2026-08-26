// One Plugin's page.
//
// A Plugin is a collection of contributions and nothing more, so the page is its contributions
// grouped by kind — plus the two things that belong to the bundle rather than to any one
// contribution: where it came from, and what it reaches.
//
// There is no Plugin on/off, and no update state: every Plugin is first-party and ships with
// cogwork, so updating one is updating the app.

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
import { TooltipProvider } from "@cogwork/ui/components/tooltip";
import { RiArrowLeftSLine, RiBox3Line, RiCheckLine, RiDeleteBinLine, RiSubtractLine } from "@remixicon/react";
import { Link } from "@tanstack/react-router";
import { contributionKinds, type InstalledPlugin, kindLabelsPlural } from "../features/configuration-model";
import { contributionsOf, sourceLine } from "../features/plugins-view";
import { FidelityBadge } from "./configuration-atoms";
import { ContributionRow } from "./contribution-row";
import { ListRow, ListRows, ListSection } from "./customize-list";

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
            <span>{sourceLine(plugin)}</span>
            {plugin.requiredConnections.map((connection) => (
              // Names the requirement and nothing about the grant. A Plugin only offers.
              <Badge key={connection} variant="outline">
                Requires {connection}
              </Badge>
            ))}
          </div>
        </div>

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
      </div>
    </TooltipProvider>
  );
}
