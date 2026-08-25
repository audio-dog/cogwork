import { Card } from "@cogwork/ui/components/card";
import { DropdownMenuItem } from "@cogwork/ui/components/dropdown-menu";
import type { ReactNode } from "react";

function CatalogEntryCard({ children }: { children: ReactNode }) {
  return <Card size="sm">{children}</Card>;
}

function CatalogEntryMenuItem({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <DropdownMenuItem onClick={onClick}>{children}</DropdownMenuItem>;
}

export const CatalogEntry = {
  Card: CatalogEntryCard,
  MenuItem: CatalogEntryMenuItem,
};
