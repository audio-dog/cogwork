// PROTOTYPE — a page that exists in the navigation and has no content yet.
//
// An empty page that says what it will hold is worth more than no page: it fixes the shape of the
// navigation, which is a decision, without pretending to a design that is not made.

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@cogwork/ui/components/empty";
import type { ComponentType, ReactNode } from "react";

export function PagePlaceholder({
  icon: Icon,
  title,
  children,
}: {
  icon: ComponentType;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-2xl px-8 py-16">
      <Empty className="w-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{children}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}
