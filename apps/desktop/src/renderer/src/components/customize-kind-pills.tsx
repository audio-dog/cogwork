// PROTOTYPE — the kind filter, shared by every variant.
//
// Kind was never the contested axis; the level control is. Holding this constant keeps the
// comparison honest.

import { Badge } from "@cogwork/ui/components/badge";
import { Button } from "@cogwork/ui/components/button";
import { Separator } from "@cogwork/ui/components/separator";
import { RiBox3Line } from "@remixicon/react";
import { contributionKinds, kindLabelsPlural, type ScopeKind } from "../features/configuration-model";
import { type Facet, kindCount } from "./customize-filter";

export function KindPills({
  facet,
  places,
  onSelect,
  children,
}: {
  facet: Facet;
  places: readonly ScopeKind[];
  onSelect: (facet: Facet) => void;
  /** A level control that belongs inline with the pills, as in the split-dropdown variant. */
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {children ? (
        <>
          {children}
          <Separator orientation="vertical" className="h-6" />
        </>
      ) : null}
      <Button
        variant={facet === "plugins" ? "secondary" : "outline"}
        size="sm"
        className="rounded-full"
        onClick={() => onSelect("plugins")}
      >
        <RiBox3Line data-icon="inline-start" />
        Plugins
      </Button>
      {contributionKinds.map((kind) => (
        <Button
          key={kind}
          variant={facet === kind ? "secondary" : "outline"}
          size="sm"
          className="rounded-full"
          onClick={() => onSelect(kind)}
        >
          {kindLabelsPlural[kind]}
          <Badge variant="ghost" className="ms-1 px-1">
            {kindCount(kind, places)}
          </Badge>
        </Button>
      ))}
    </div>
  );
}
