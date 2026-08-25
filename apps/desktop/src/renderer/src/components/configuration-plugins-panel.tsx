// PROTOTYPE — the Plugins surface.
//
// Shared by all three variants on purpose. What the variants disagree about is whether Plugins is
// a facet of one surface or a surface of its own, and how Customize is organized — not what an
// install card says. Three copies of the same card would bury that disagreement.
//
// Plugins owns membership: install, stage an update, accept, decline, uninstall, and refresh the
// catalog. It writes no contribution setting and no credential state.

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
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
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cogwork/ui/components/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@cogwork/ui/components/collapsible";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@cogwork/ui/components/item";
import { Separator } from "@cogwork/ui/components/separator";
import {
  RiArrowRightSLine,
  RiCheckLine,
  RiDeleteBinLine,
  RiDownloadLine,
  RiErrorWarningLine,
  RiInformationLine,
  RiLoopLeftLine,
  RiShieldKeyholeLine,
  RiSubtractLine,
} from "@remixicon/react";
import type { CatalogEntry, InstalledPlugin, ReachDiff } from "../features/configuration-model";
import { kindLabels } from "../features/configuration-model";
import { contributionById, placeholderConfiguration } from "../features/configuration-placeholder";
import { CatalogStatusBadge, FidelityBadge, IdentityBadge, kindIcons } from "./configuration-atoms";

const { plugins, catalog } = placeholderConfiguration;

function sourceLabel(plugin: InstalledPlugin): string {
  const { source } = plugin.record;
  return source._tag === "catalog" ? `catalog · ${source.entryId}` : `local path · ${source.path}`;
}

/**
 * The comparison ADR 0014's staged provision makes possible: reach over the contributions
 * currently **on**, with additions and drops enumerated beside it and no reach claimed for them.
 * One act accepts or declines the whole thing.
 */
function StagedUpdate({ identity, reach }: { identity: string; reach: ReachDiff }) {
  return (
    <Alert>
      <RiDownloadLine />
      <AlertTitle className="flex flex-wrap items-center gap-1.5">
        An update is staged
        <IdentityBadge identity={identity} />
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-3">
        <p>
          The bytes are written at a key nothing points at. Accepting repoints the install record; declining
          discards them and touches nothing.
        </p>

        {reach.changed.length > 0 ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">Reach changes, over what is on</span>
            {reach.changed.map((change) => (
              <div key={change.contributionId} className="flex flex-col rounded-md border border-border p-2">
                <span className="font-mono text-xs">{change.contributionId}</span>
                <span className="text-xs text-muted-foreground line-through">{change.before}</span>
                <span className="text-xs">{change.after}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs">Nothing this Plugin reaches has changed.</p>
        )}

        {reach.added.length > 0 ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">Added</span>
            {reach.added.map((entry) => (
              <span key={entry.contributionId} className="font-mono text-xs text-muted-foreground">
                {entry.contributionId} — a new {kindLabels[entry.kind]}, off until you turn it on
              </span>
            ))}
          </div>
        ) : null}

        {reach.dropped.length > 0 ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">Dropped</span>
            {reach.dropped.map((entry) => (
              <span key={entry.contributionId} className="font-mono text-xs text-muted-foreground">
                {entry.contributionId} — its setting is deleted at every Scope you own
              </span>
            ))}
          </div>
        ) : null}
      </AlertDescription>
      <AlertAction>
        <div className="flex gap-2">
          {/* The accept names the resolved identity it accepts — not a bare confirmation. */}
          <Button size="sm">Accept {identity}</Button>
          <Button size="sm" variant="outline">
            Decline
          </Button>
        </div>
      </AlertAction>
    </Alert>
  );
}

function PermissionSummary({ plugin }: { plugin: InstalledPlugin }) {
  return (
    <Collapsible>
      <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="w-full justify-start" />}>
        <RiShieldKeyholeLine data-icon="inline-start" />
        What this Plugin reaches
        <RiArrowRightSLine data-icon="inline-end" />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 pt-2">
        {/* Derived from the bundle's files, never declared — a declared summary is a self-claim. */}
        <p className="text-xs text-muted-foreground">
          Computed from this bundle's files. Three postures are enforced exactly; anything finer is recorded
          as coarse and never presented as exact.
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
        {plugin.requiredConnections.length > 0 ? (
          <>
            <Separator />
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium">Required Connections</span>
              {/* Names the Connection and nothing about the grant. A Plugin only offers. */}
              {plugin.requiredConnections.map((connection) => (
                <span key={connection} className="text-xs text-muted-foreground">
                  {connection} — required. This requirement gates nothing here; an unsatisfiable need is
                  refused when a Run Plan resolves.
                </span>
              ))}
            </div>
          </>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function SetupChecklist({ plugin }: { plugin: InstalledPlugin }) {
  if (plugin.setup.length === 0) return null;
  const remaining = plugin.setup.filter((step) => !step.done).length;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <span className="text-sm font-medium">
        {remaining === 0 ? "Setup complete" : `Setup — ${remaining} left`}
      </span>
      {plugin.setup.map((step) => (
        <div key={step.id} className="flex items-start gap-2">
          {step.done ? (
            <RiCheckLine className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          ) : (
            <RiSubtractLine className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="flex min-w-0 flex-col">
            <span className="text-sm">{step.label}</span>
            <span className="text-xs text-muted-foreground">{step.detail}</span>
          </span>
          {step.done ? null : (
            <Button size="xs" variant="outline" className="ms-auto">
              Do it
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

function InstalledPluginCard({ plugin }: { plugin: InstalledPlugin }) {
  const contributions = plugin.contributionIds.map(contributionById).filter((entry) => entry !== undefined);
  const failed = contributions.filter((entry) => entry.load._tag === "failed");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {plugin.name}
          <IdentityBadge identity={plugin.record.resolvedIdentity} />
        </CardTitle>
        <CardDescription>{plugin.summary}</CardDescription>
        <CardAction>
          <div className="flex items-center gap-2">
            {plugin.update._tag === "available" ? (
              <Button size="sm" variant="outline">
                <RiDownloadLine data-icon="inline-start" />
                Stage update
              </Button>
            ) : null}
            <AlertDialog>
              <AlertDialogTrigger render={<Button size="icon-sm" variant="ghost" aria-label="Uninstall" />}>
                <RiDeleteBinLine />
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogTitle>Uninstall {plugin.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This deletes its settings at every Scope you own — your Settings profile and every private
                  workspace overlay. A committed Workspace input is not yours to delete, so anything it wrote
                  for this Plugin is left in place and will dangle.
                </AlertDialogDescription>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep it</AlertDialogCancel>
                  <AlertDialogAction variant="destructive">Uninstall</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="font-mono text-xs text-muted-foreground">{sourceLabel(plugin)}</p>

        {plugin.update._tag === "staged" ? (
          <StagedUpdate identity={plugin.update.resolvedIdentity} reach={plugin.update.reach} />
        ) : null}

        {failed.length > 0 ? (
          <Alert variant="destructive">
            <RiErrorWarningLine />
            <AlertTitle>
              {failed.length === 1
                ? "This Plugin ships a contribution that failed to load"
                : `${failed.length} of this Plugin's contributions failed to load`}
            </AlertTitle>
            <AlertDescription className="flex flex-col gap-2">
              {failed.map((entry) => (
                <span key={entry.id} className="flex flex-col">
                  <span className="font-mono text-xs">{entry.file}</span>
                  <span className="text-xs">{entry.load._tag === "failed" ? entry.load.reason : ""}</span>
                </span>
              ))}
              <span className="text-xs">
                A malformed file yields no contribution, so any setting written for it dangles.
              </span>
            </AlertDescription>
          </Alert>
        ) : null}

        <SetupChecklist plugin={plugin} />

        <div className="flex flex-wrap gap-1.5">
          {contributions.map((entry) => {
            const Icon = kindIcons[entry.kind];
            return (
              <Badge key={entry.id} variant="outline">
                <Icon />
                {entry.localName}
              </Badge>
            );
          })}
        </div>

        <PermissionSummary plugin={plugin} />
      </CardContent>
    </Card>
  );
}

function CatalogRow({ entry, installed }: { entry: CatalogEntry; installed: boolean }) {
  const withdrawn = entry.status._tag === "deleted";
  return (
    <Item variant="outline" className="items-start">
      <ItemMedia variant="icon">
        <RiDownloadLine />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex flex-wrap items-center gap-1.5">
          {entry.name}
          <CatalogStatusBadge status={entry.status} />
          {installed ? <Badge variant="secondary">Installed</Badge> : null}
        </ItemTitle>
        <ItemDescription>{entry.summary}</ItemDescription>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{entry.digest}</p>
        {withdrawn && entry.status._tag === "deleted" ? (
          <p className="mt-1 text-xs text-destructive">{entry.status.message}</p>
        ) : null}
      </ItemContent>
      <ItemActions>
        {installed ? (
          <span className="text-xs text-muted-foreground">Manage it above</span>
        ) : (
          // `deleted` bounds what install may resolve. It never disables what is already installed.
          <Button size="sm" variant="outline" disabled={withdrawn}>
            {withdrawn ? "Unavailable" : "Install"}
          </Button>
        )}
      </ItemActions>
    </Item>
  );
}

function CatalogSection() {
  const installedEntryIds = plugins
    .map((plugin) => plugin.record.source)
    .filter((source) => source._tag === "catalog")
    .map((source) => source.entryId);

  if (catalog._tag === "never-fetched") {
    return (
      <div className="flex flex-col gap-3">
        <Alert>
          <RiInformationLine />
          <AlertTitle>The catalog has never been fetched</AlertTitle>
          <AlertDescription>
            A refresh runs only when you ask for one — never on a timer, and never on read.
          </AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline">
              <RiLoopLeftLine data-icon="inline-start" />
              Refresh
            </Button>
          </AlertAction>
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* `stale` and `fetched` must not render alike, so the failure is stated, not implied. */}
      {catalog._tag === "stale" ? (
        <Alert>
          <RiErrorWarningLine />
          <AlertTitle>Showing a stale catalog</AlertTitle>
          <AlertDescription>
            Fetched {catalog.at}. The last refresh failed: {catalog.lastFailure}
          </AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline">
              <RiLoopLeftLine data-icon="inline-start" />
              Refresh
            </Button>
          </AlertAction>
        </Alert>
      ) : (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Fetched {catalog.at}</span>
          <Button size="sm" variant="outline">
            <RiLoopLeftLine data-icon="inline-start" />
            Refresh
          </Button>
        </div>
      )}
      <ItemGroup className="gap-2">
        {catalog.entries.map((entry) => (
          <CatalogRow key={entry.id} entry={entry} installed={installedEntryIds.includes(entry.id)} />
        ))}
      </ItemGroup>
    </div>
  );
}

export function PluginsPanel() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">Installed</h2>
        {plugins.map((plugin) => (
          <InstalledPluginCard key={plugin.record.pluginId} plugin={plugin} />
        ))}
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-muted-foreground">Catalog</h2>
        <CatalogSection />
      </div>

      {/*
        `pin` is on the install record and in the Plugins glossary entry, and #135 found it has no
        semantics: every update is already an explicit, declinable act. #203 owns it. Rendering a
        control for it would invent the meaning this map declined to mint.
      */}
      <p className="text-xs text-muted-foreground">
        No pin control. #135 found `pin` undefined — every update is already declinable — and #203 owns
        whether it survives.
      </p>
    </div>
  );
}
