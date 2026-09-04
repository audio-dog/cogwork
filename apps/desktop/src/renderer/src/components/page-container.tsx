import { cn } from "@cogwork/ui/lib/utils";
import type { ComponentProps } from "react";

interface PageContainerProps extends ComponentProps<"div"> {
  readonly width: "readable" | "standard" | "wide";
}

export function PageContainer({ className, width, ...props }: PageContainerProps) {
  return (
    <div
      {...props}
      className={cn(
        "mx-auto w-full px-8 pb-12",
        width === "readable" && "max-w-2xl",
        width === "standard" && "max-w-3xl",
        width === "wide" && "max-w-5xl",
        className,
      )}
    />
  );
}
