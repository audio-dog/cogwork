import { RiAlertLine, RiErrorWarningLine } from "@remixicon/react";
import type * as React from "react";

import { Alert, AlertDescription, AlertTitle } from "#components/alert";

const toneIcon = {
  warning: RiAlertLine,
  error: RiErrorWarningLine,
} as const;

const toneRole = {
  warning: "status",
  error: "alert",
} as const;

export function AlertBanner({
  tone,
  title,
  children,
}: {
  readonly tone: keyof typeof toneIcon;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  const Icon = toneIcon[tone];
  return (
    <Alert variant={tone} role={toneRole[tone]}>
      <Icon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
