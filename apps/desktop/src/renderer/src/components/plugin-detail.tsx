import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@cogwork/ui/components/alert-dialog";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import { ItemContent, ItemDescription, ItemTitle } from "@cogwork/ui/components/item";
import { TooltipProvider } from "@cogwork/ui/components/tooltip";
import { RiArrowLeftSLine, RiBox3Line, RiCheckLine, RiDeleteBinLine, RiSubtractLine } from "@remixicon/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import {
  type Contribution,
  contributionKinds,
  type InstalledPlugin,
  kindLabelsPlural,
  type SetupStep,
} from "../features/configuration-model";
import { pluginFailureTitle, useConfiguration } from "./configuration-provider";
import { ContributionFileRow } from "./contribution-file-row";
import {
  ListRow,
  ListRowActions,
  ListRowMedia,
  ListSection,
  ListSectionBody,
  ListSectionHeader,
  ListSectionRows,
} from "./customize-list";
import { McpServerRow } from "./mcp-server-row";

function FidelityBadge({ fidelity }: { fidelity: "exact" | "coarse" }) {
  if (fidelity === "exact") return <Badge variant="outline">Enforced</Badge>;
  return <Badge variant="secondary">Coarse</Badge>;
}

function SetupRow({ step }: { step: SetupStep }) {
  return (
    <ListRow>
      <ListRowMedia status={step.done ? "ok" : "attention"}>
        {step.done ? <RiCheckLine /> : <RiSubtractLine />}
      </ListRowMedia>
      <ItemContent>
        <ItemTitle>{step.label}</ItemTitle>
        <ItemDescription>{step.detail}</ItemDescription>
      </ItemContent>
      <ListRowActions>
        {step.done ? (
          <Badge variant="ghost">Done</Badge>
        ) : (
          <Button size="sm" variant="outline">
            Do it
          </Button>
        )}
      </ListRowActions>
    </ListRow>
  );
}

function UninstallDialog({ plugin }: { plugin: InstalledPlugin }) {
  const [open, setOpen] = useState(false);
  const {
    actions: { uninstallPlugin },
  } = useConfiguration();
  const uninstall = () => {
    uninstallPlugin(plugin.record.pluginId);
    setOpen(false);
  };
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={<Button size="sm" variant="ghost" />}>
        <RiDeleteBinLine data-icon="inline-start" />
        Uninstall
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Uninstall {plugin.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This deletes its settings at every place you own — this machine and every private overlay. A
            committed repository file is not yours to delete, so anything it wrote for this Plugin is left in
            place and will dangle.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={uninstall}>
            Uninstall
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ContributionRow({ contribution }: { contribution: Contribution }) {
  if (contribution.kind === "mcp-server") return <McpServerRow contribution={contribution} />;
  return <ContributionFileRow contribution={contribution} />;
}

export function PluginDetail({ plugin }: { plugin: InstalledPlugin }) {
  const {
    meta: { plugins, pluginFailure },
  } = useConfiguration();
  const rows = plugins.contributionsOf(plugin);
  const remaining = plugin.setup.filter((step) => !step.done);

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-6">
        <Button
          variant="ghost"
          size="sm"
          className="w-fit"
          nativeButton={false}
          render={<Link to="/customize/$facet" params={{ facet: "plugins" }} />}
        >
          <RiArrowLeftSLine data-icon="inline-start" />
          Customize
        </Button>

        {pluginFailure ? (
          <Alert variant="destructive">
            <AlertTitle>{pluginFailureTitle(pluginFailure)}</AlertTitle>
            <AlertDescription className="whitespace-pre-wrap">{pluginFailure.message}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-5">
            <RiBox3Line />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <h1 className="font-heading text-2xl font-semibold tracking-tight">{plugin.name}</h1>
            <p className="text-sm text-muted-foreground">{plugin.summary}</p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {plugin.requiredConnections.map((connection) => (
                <Badge key={connection} variant="outline">
                  Requires {connection}
                </Badge>
              ))}
            </p>
          </div>
          <UninstallDialog plugin={plugin} />
        </div>

        {remaining.length > 0 ? (
          <ListSection>
            <ListSectionHeader title="Setup" count={plugin.setup.length} />
            <ListSectionRows items={plugin.setup} keyOf={(step) => step.id}>
              {(step) => <SetupRow step={step} />}
            </ListSectionRows>
          </ListSection>
        ) : null}

        {contributionKinds.map((kind) => {
          const ofKind = rows.filter((contribution) => contribution.kind === kind);
          if (ofKind.length === 0) return null;
          return (
            <ListSection key={kind}>
              <ListSectionHeader title={kindLabelsPlural[kind]} count={ofKind.length} />
              <ListSectionRows items={ofKind} keyOf={(contribution) => contribution.id}>
                {(contribution) => <ContributionRow contribution={contribution} />}
              </ListSectionRows>
            </ListSection>
          );
        })}

        {rows.length === 0 ? (
          <Empty className="py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <RiBox3Line />
              </EmptyMedia>
              <EmptyTitle>Nothing loaded</EmptyTitle>
              <EmptyDescription>None of its files produced a contribution.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        <ListSection>
          <ListSectionHeader title="What it reaches" count={plugin.permissions.length} />
          <ListSectionBody>
            <div className="flex flex-col gap-2 p-3">
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
          </ListSectionBody>
        </ListSection>
      </div>
    </TooltipProvider>
  );
}
