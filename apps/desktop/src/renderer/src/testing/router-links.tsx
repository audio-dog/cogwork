import type { KeyboardEvent, ReactNode } from "react";
import { vi } from "vitest";

export const navigate = vi.fn(async (_destination: unknown) => undefined);

export const withRouterLinks = <Router extends object>(router: Router) => ({
  ...router,
  Link: ({
    children,
    to,
    params,
    onClick,
    onKeyDown,
    "aria-label": ariaLabel,
  }: {
    readonly children?: ReactNode;
    readonly to?: string;
    readonly params?: { readonly workflowId?: string };
    readonly onClick?: (event: { readonly defaultPrevented: boolean }) => void;
    readonly onKeyDown?: (event: KeyboardEvent<HTMLAnchorElement>) => void;
    readonly "aria-label"?: string;
  }) => (
    <a
      href={to ?? "/workflows"}
      aria-label={ariaLabel}
      onClick={async (event) => {
        onClick?.(event);
        if (event.defaultPrevented || to !== "/workflows/$workflowId" || !params?.workflowId) return;
        await navigate({ to, params: { workflowId: params.workflowId } });
      }}
      onKeyDown={onKeyDown}
    >
      {children}
    </a>
  ),
  useNavigate: () => navigate,
});
