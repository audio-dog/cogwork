// PROTOTYPE — Customize, Variant B: Scope tabs.
//
// The claim: **Scope is the only filter, and kind becomes navigation.** You stand at one rung, see
// everything written there in one scroll, and jump between kinds instead of filtering to them. The
// write target is never ambiguous because it is the tab you are standing on.
//
// It also gets one thing for free from collapsing the ladder: an install is machine-local, so
// Plugins belongs on the machine rung and nowhere else. There is no longer a rung it could float
// between.

import { Alert, AlertDescription, AlertTitle } from "@cogwork/ui/components/alert";
import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@cogwork/ui/components/empty";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@cogwork/ui/components/tabs";
import { ToggleGroup, ToggleGroupItem } from "@cogwork/ui/components/toggle-group";
import { cn } from "@cogwork/ui/lib/utils";
import { RiBox3Line, RiInformationLine } from "@remixicon/react";
import { useState } from "react";
import { draftCellAt, withDraft } from "../features/configuration-draft";
import {
  type Contribution,
  type ContributionKind,
  contributionKinds,
  type DraftCell,
  enablementScopes,
  kindLabelsPlural,
  type ScopeKind,
  type ScopeRef,
  scopeDescriptions,
  scopeLabels,
  scopeOrder,
} from "../features/configuration-model";
import { placeholderConfiguration } from "../features/configuration-placeholder";
import { resolveEnablement } from "../features/configuration-resolve";
import { useConfigurationDraftStore } from "../store/configuration-draft";
import {
  AuthorityBadge,
  DiagnosticBadge,
  describeScope,
  kindIcons,
  ReadinessBadge,
} from "./configuration-atoms";
import { PluginsPanel } from "./configuration-plugins-panel";
import { useWorkspaceId, WorkspacePicker } from "./customize-atoms";

const { contributions, workspaces } = placeholderConfiguration;

const workspaceBound: readonly ScopeKind[] = ["workspace-input", "private-overlay"];

/** Why a rung refuses a kind. The reason is the decision, so it gets stated. */
const exclusionReason =
  "A repository you cloned must not start a process on your machine. It may still ship the file — an offer is data; an enablement is not.";

function sectionId(scope: ScopeKind, kind: ContributionKind | "plugins") {
  return `customize-${scope}-${kind}`;
}

function ContributionRowAtScope({ contribution, scope }: { contribution: Contribution; scope: ScopeRef }) {
  const cells = useConfigurationDraftStore((state) => state.cells);
  const setCell = useConfigurationDraftStore((state) => state.setCell);
  const workspaceId = useWorkspaceId();

  const edited = withDraft(contribution, cells);
  const cell = draftCellAt(contribution, scope, cells);
  const resolved = resolveEnablement(edited, { workspaceId });
  const failed = contribution.load._tag === "failed";
  const here = resolved.winner !== undefined && resolved.winner.scope.kind === scope.kind;
  const Icon = kindIcons[contribution.kind];

  return (
    <Item variant="outline" className="items-start">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{contribution.localName}</span>
          <AuthorityBadge authority={contribution.authority} />
          {contribution.readiness ? <ReadinessBadge readiness={contribution.readiness} /> : null}
          {resolved.dropped.map((entry) => (
            <DiagnosticBadge key={entry.diagnostic._tag} diagnostic={entry.diagnostic} />
          ))}
          {failed ? <Badge variant="destructive">Failed to load</Badge> : null}
        </ItemTitle>
        <ItemDescription>{contribution.summary}</ItemDescription>
        {failed && contribution.load._tag === "failed" ? (
          <p className="mt-1 text-xs text-destructive">{contribution.load.reason}</p>
        ) : null}

        {/* Inheritance stated from where you are standing, rather than as a merged value. */}
        {cell === "unset" ? (
          resolved.winner ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Nothing written here. Inherits {resolved.effective ? "on" : "off"} from{" "}
              {describeScope(resolved.winner.scope, workspaces)}.
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              Nothing written here, and nothing at any other rung. Not off — not there.
            </p>
          )
        ) : here ? (
          <p className="mt-1 text-xs text-muted-foreground">
            This is the value a Run gets.
            {resolved.shadowed.length > 0
              ? ` It outranks ${resolved.shadowed.length} lower ${resolved.shadowed.length === 1 ? "rung" : "rungs"}.`
              : ""}
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            Written here, but{" "}
            {resolved.winner
              ? `${describeScope(resolved.winner.scope, workspaces)} is higher and wins whole.`
              : "dropped before resolution."}
          </p>
        )}
      </ItemContent>
      <ItemActions>
        <ToggleGroup
          value={[cell]}
          disabled={failed}
          onValueChange={(values) => {
            const next = values[0];
            if (next) setCell(contribution.id, scope, next as DraftCell);
          }}
          size="sm"
        >
          <ToggleGroupItem value="on" aria-label="On">
            On
          </ToggleGroupItem>
          <ToggleGroupItem value="off" aria-label="Off">
            Off
          </ToggleGroupItem>
          <ToggleGroupItem value="unset" aria-label="Not set">
            Not set
          </ToggleGroupItem>
        </ToggleGroup>
      </ItemActions>
    </Item>
  );
}

function KindSection({ kind, scope }: { kind: ContributionKind; scope: ScopeRef }) {
  const permitted = enablementScopes[kind].includes(scope.kind);
  const rows = contributions.filter((contribution) => contribution.kind === kind);

  return (
    <section id={sectionId(scope.kind, kind)} className="flex scroll-mt-4 flex-col gap-2">
      <h3 className="text-sm font-medium">{kindLabelsPlural[kind]}</h3>
      {!permitted ? (
        <Alert>
          <RiInformationLine />
          <AlertTitle>Cannot be turned on at this rung</AlertTitle>
          <AlertDescription>{exclusionReason}</AlertDescription>
        </Alert>
      ) : rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No {kindLabelsPlural[kind]}</EmptyTitle>
            <EmptyDescription>Nothing contributes this kind yet.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="gap-2">
          {rows.map((contribution) => (
            <ContributionRowAtScope key={contribution.id} contribution={contribution} scope={scope} />
          ))}
        </ItemGroup>
      )}
    </section>
  );
}

/** Kind as navigation rather than a filter: this jumps, it does not narrow. */
function JumpList({ scope }: { scope: ScopeRef }) {
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ block: "start" });
  const machine = scope.kind === "runtime-host";

  return (
    <nav className="sticky top-2 flex w-44 shrink-0 flex-col gap-0.5 self-start">
      {machine ? (
        <Button
          variant="ghost"
          size="sm"
          className="justify-start"
          onClick={() => jump(sectionId(scope.kind, "plugins"))}
        >
          <RiBox3Line data-icon="inline-start" />
          Plugins
        </Button>
      ) : null}
      {contributionKinds.map((kind) => {
        const permitted = enablementScopes[kind].includes(scope.kind);
        const count = contributions.filter((contribution) => contribution.kind === kind).length;
        return (
          <Button
            key={kind}
            variant="ghost"
            size="sm"
            className={cn("justify-start", !permitted && "text-muted-foreground/60")}
            onClick={() => jump(sectionId(scope.kind, kind))}
          >
            <span className="truncate">{kindLabelsPlural[kind]}</span>
            <Badge variant="ghost" className="ms-auto px-1">
              {permitted ? count : "—"}
            </Badge>
          </Button>
        );
      })}
    </nav>
  );
}

export function CustomizeVariantB() {
  const [scopeKindValue, setScopeKind] = useState<ScopeKind>("runtime-host");
  const workspaceId = useWorkspaceId();
  const scope: ScopeRef = workspaceBound.includes(scopeKindValue)
    ? { kind: scopeKindValue, workspaceId }
    : { kind: scopeKindValue };

  return (
    <Tabs value={scopeKindValue} onValueChange={(value) => setScopeKind(value as ScopeKind)}>
      <TabsList className="w-full">
        {scopeOrder.map((kind) => (
          <TabsTrigger key={kind} value={kind}>
            {scopeLabels[kind]}
          </TabsTrigger>
        ))}
      </TabsList>

      {scopeOrder.map((kind) => (
        <TabsContent key={kind} value={kind} className="flex flex-col gap-4 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-xl text-xs text-muted-foreground">
              {scopeDescriptions[kind]} Rung {scopeOrder.indexOf(kind) + 1} of {scopeOrder.length}, low to
              high — every switch below writes here and nowhere else.
            </p>
            {workspaceBound.includes(kind) ? <WorkspacePicker label="in" /> : null}
          </div>

          <Separator />

          <div className="flex min-h-0 gap-6">
            <JumpList scope={scope} />
            <div className="flex min-w-0 flex-1 flex-col gap-6">
              {kind === "runtime-host" ? (
                <section id={sectionId(kind, "plugins")} className="flex scroll-mt-4 flex-col gap-2">
                  <h3 className="text-sm font-medium">Plugins</h3>
                  <p className="text-xs text-muted-foreground">
                    An install is machine-local, so Plugins sits on this rung and no other. Collapsing the
                    ladder is what removed the question of where it belonged.
                  </p>
                  <PluginsPanel />
                </section>
              ) : null}
              {contributionKinds.map((contributionKind) => (
                <KindSection key={contributionKind} kind={contributionKind} scope={scope} />
              ))}
            </div>
          </div>
        </TabsContent>
      ))}
    </Tabs>
  );
}
