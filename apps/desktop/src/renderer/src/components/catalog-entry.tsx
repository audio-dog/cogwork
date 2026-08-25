import { DropdownMenuItem } from "@cogwork/ui/components/dropdown-menu";
import type { RemixiconComponentType } from "@remixicon/react";

function CatalogEntryCard({
  description,
  icon: Icon,
  title,
  onClick,
}: {
  description: string;
  icon: RemixiconComponentType;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      className="flex flex-col items-start gap-1 rounded-xl bg-card p-4 text-left ring-1 ring-foreground/10 transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      type="button"
      onClick={onClick}
    >
      <Icon className="mb-2 size-5" />
      <span className="font-heading text-sm font-medium">{title}</span>
      <span className="text-sm text-muted-foreground">{description}</span>
    </button>
  );
}

function CatalogEntryMenuItem({
  icon: Icon,
  title,
  onClick,
}: {
  icon: RemixiconComponentType;
  title: string;
  onClick: () => void;
}) {
  return (
    <DropdownMenuItem onClick={onClick}>
      <Icon />
      {title}
    </DropdownMenuItem>
  );
}

export const CatalogEntry = {
  Card: CatalogEntryCard,
  MenuItem: CatalogEntryMenuItem,
};
