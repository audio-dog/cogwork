import { RiLoaderLine } from "@remixicon/react";
import type { ComponentProps } from "react";

import { cn } from "#lib/utils";

function Spinner({ className, ...props }: ComponentProps<typeof RiLoaderLine>) {
  return (
    <output data-slot="spinner" aria-label="Loading" className="inline-flex">
      <RiLoaderLine aria-hidden className={cn("size-4 animate-spin", className)} {...props} />
    </output>
  );
}

export { Spinner };
