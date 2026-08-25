import type { ReactNode } from "react";

function CatalogEntryCard({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      className="flex flex-col items-start gap-1 rounded-xl bg-card p-4 text-left ring-1 ring-foreground/10 transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function CatalogEntryMedia({ children }: { children: ReactNode }) {
  return <span className="mb-2 [&_svg]:size-5">{children}</span>;
}

function CatalogEntryTitle({ children }: { children: ReactNode }) {
  return <span className="font-heading text-sm font-medium">{children}</span>;
}

function CatalogEntryDescription({ children }: { children: ReactNode }) {
  return <span className="text-sm text-muted-foreground">{children}</span>;
}

export const CatalogEntry = {
  Card: CatalogEntryCard,
  Media: CatalogEntryMedia,
  Title: CatalogEntryTitle,
  Description: CatalogEntryDescription,
};
