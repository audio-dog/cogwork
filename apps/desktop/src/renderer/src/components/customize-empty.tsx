import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import type { ComponentType } from "react";

import { useCustomizeFilter } from "./customize-filter";

/**
 * Why a Facet has nothing to show. Saying "none yet" when a filter did the emptying reads as a
 * status rather than a filter result, so each cause has to be told apart before it is worded.
 */
export type EmptyReason = "no-places" | "no-match" | "none-yet";

export function emptyReason(places: readonly string[], query: string): EmptyReason {
  if (places.length === 0) return "no-places";
  if (query.trim() !== "") return "no-match";
  return "none-yet";
}

/** Plugins are machine-local, so the Place axis cannot empty the list — only the query can. */
export function searchEmptyReason(query: string): Exclude<EmptyReason, "no-places"> {
  return query.trim() !== "" ? "no-match" : "none-yet";
}

function EmptyState({
  icon: Icon,
  title,
  children,
}: {
  icon: ComponentType;
  title: string;
  children: string;
}) {
  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function NoMatch({ icon, query }: { icon: ComponentType; query: string }) {
  return (
    <EmptyState icon={icon} title="No matches">
      {`Nothing here matches “${query.trim()}”.`}
    </EmptyState>
  );
}

export function FilteredEmpty({ icon, label }: { icon: ComponentType; label: string }) {
  const {
    state: { places, query },
  } = useCustomizeFilter();
  const reason = emptyReason(places, query);

  if (reason === "no-places") {
    return (
      <EmptyState icon={icon} title="Nothing selected">
        Choose where to look.
      </EmptyState>
    );
  }
  if (reason === "no-match") return <NoMatch icon={icon} query={query} />;
  return (
    <EmptyState icon={icon} title={`No ${label} yet`}>
      Nothing in the places you picked.
    </EmptyState>
  );
}

export function SearchEmpty({ icon, label }: { icon: ComponentType; label: string }) {
  const {
    state: { query },
  } = useCustomizeFilter();

  if (searchEmptyReason(query) === "no-match") return <NoMatch icon={icon} query={query} />;
  return (
    <EmptyState icon={icon} title={`No ${label} yet`}>
      Nothing is installed on this machine.
    </EmptyState>
  );
}
