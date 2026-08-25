// PROTOTYPE — the third settings surface, which has no name.
//
// #133 fixed this surface's boundary and deliberately refused to mint its name: it is neither
// Plugins nor Customize, and `Settings` sits on Customize's *Avoid* line. It owns workspace
// registration, the daemon's runtime limits, and Control store restore. Naming it is a
// `/domain-modeling` act on the maintainer's say-so, so this file uses a description, not a noun.

import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@cogwork/ui/components/card";
import { Field, FieldLabel } from "@cogwork/ui/components/field";
import { Input } from "@cogwork/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@cogwork/ui/components/item";
import { RiAddLine, RiGitRepositoryLine, RiInformationLine } from "@remixicon/react";
import { placeholderConfiguration } from "../features/configuration-placeholder";

const { workspaces, limits, controlStore } = placeholderConfiguration;

function WorkspaceRow({ workspace }: { workspace: (typeof workspaces)[number] }) {
  // Two workspaces may share one remote, so the checkout path is what tells them apart.
  const sharesRemote =
    workspace.remote !== undefined &&
    workspaces.filter((candidate) => candidate.remote === workspace.remote).length > 1;

  return (
    <Item variant="outline" className="items-start">
      <ItemMedia variant="icon">
        <RiGitRepositoryLine />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex flex-wrap items-center gap-1.5">
          {workspace.name}
          <Badge variant="outline" className="font-mono">
            {workspace.id}
          </Badge>
          <Badge variant="secondary">{workspace.tracker}</Badge>
        </ItemTitle>
        <ItemDescription className="font-mono">{workspace.checkoutPath}</ItemDescription>
        <p className="mt-1 font-mono text-xs text-muted-foreground">{workspace.remote}</p>
        {sharesRemote ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Another workspace shares this remote. The path and the remote are hints for re-binding; the minted
            WorkspaceId above is the identity.
          </p>
        ) : null}
      </ItemContent>
      <ItemActions className="flex-col items-end gap-1">
        <Button size="sm" variant="outline">
          Re-bind path
        </Button>
        <AlertDialog>
          <AlertDialogTrigger render={<Button size="sm" variant="ghost" />}>Deregister</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>Deregister {workspace.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              One act, and it cascades: the registration, every contribution setting written at this
              workspace's Workspace input Scope, and every one at its Private workspace overlay. Run history
              is not cascaded — losing a workspace should not erase what it did.
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it</AlertDialogCancel>
              <AlertDialogAction variant="destructive">Deregister</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </ItemActions>
    </Item>
  );
}

export function WorkspacesPanel() {
  return (
    <div className="flex flex-col gap-6">
      {/*
        The gap is the point: this surface exists, its contents are settled, and its name is not.
        Rendering a coined noun here would mint the term the map declined to mint.
      */}
      <Alert>
        <RiInformationLine />
        <AlertTitle>This surface has no name yet.</AlertTitle>
        <AlertDescription>
          #133 fixed what it owns — workspace registration, the daemon's runtime limits, and Control store
          restore — and refused to name it. It is neither Plugins nor Customize, and `Settings` is on
          Customize's Avoid list. The heading above is a placeholder.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Registered workspaces</CardTitle>
          <CardDescription>
            Register mints a WorkspaceId. Re-bind moves the checkout path and never touches identity, so
            moving a repository keeps your overlay and cloning a remote twice gives two workspaces.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ItemGroup className="gap-2">
            {workspaces.map((workspace) => (
              <WorkspaceRow key={workspace.id} workspace={workspace} />
            ))}
          </ItemGroup>
          <Button size="sm" variant="outline" className="w-fit">
            <RiAddLine data-icon="inline-start" />
            Register a workspace
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>The daemon's runtime limits</CardTitle>
          <CardDescription>
            Deliberately not on the Scope axis. These describe what this daemon is doing now, so they take no
            Scope, no level, and no provenance trace.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Field>
            <FieldLabel>Global concurrency</FieldLabel>
            <Input defaultValue={String(limits.globalConcurrency)} className="w-24" />
          </Field>
          <Field>
            <FieldLabel>Per-workspace concurrency</FieldLabel>
            <Input defaultValue={String(limits.perWorkspaceConcurrency)} className="w-24" />
          </Field>
          <Field>
            <FieldLabel>Daily budget</FieldLabel>
            <Input defaultValue={String(limits.dailyBudget)} className="w-24" />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Control store</CardTitle>
          <CardDescription>
            One database per machine, under ~/.cogwork. It fails closed: a store cogwork cannot open or trust
            stops dispatch rather than degrading it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm">Schema version</span>
            <Badge variant="outline" className="font-mono">
              {controlStore.schemaVersion}
            </Badge>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm">Opened</span>
            <span className="font-mono text-xs text-muted-foreground">{controlStore.openedAt}</span>
          </div>
          {controlStore.preMigrationCopy ? (
            <Alert>
              <RiInformationLine />
              <AlertTitle>A pre-migration copy exists</AlertTitle>
              <AlertDescription>
                Taken {controlStore.preMigrationCopy.at}, at schema version{" "}
                {controlStore.preMigrationCopy.fromVersion}. Restoring is a six-step in-process pass; the
                scheduler is never paused for it.
              </AlertDescription>
            </Alert>
          ) : null}
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button
                  size="sm"
                  variant="outline"
                  className="w-fit"
                  disabled={!controlStore.preMigrationCopy}
                />
              }
            >
              Restore the pre-migration copy
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogTitle>Restore the pre-migration copy?</AlertDialogTitle>
              <AlertDialogDescription>
                Everything written since {controlStore.preMigrationCopy?.at} is discarded — install records,
                every contribution setting, every Operation setting, and the workspace registry. Run history
                is disposable by policy and is not restored.
              </AlertDialogDescription>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive">Restore</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>
    </div>
  );
}
