# Desktop app — agent guide

Applies to everything under `apps/desktop/`. Read the root `AGENTS.md` first; this only adds the
UI rules for this app.

## UI: always build on the `@cogwork/ui` design system

The desktop UI is React + Tailwind v4 + shadcn (style `base-nova`, icons `remixicon`). Shared
primitives and design tokens live in `packages/ui`; app-specific feature components live here in the
renderer (e.g. `src/renderer/src/components`). This split is set by product ADR 0009 — keep it.

When you create or change any UI element:

- **Invoke the `/shadcn` skill first.** It carries the non-obvious rules (Field/FieldGroup forms,
  `data-icon` on button icons, `gap-*` over `space-*`, semantic tokens, no manual `dark:` overrides)
  and the `docs` → `add` workflow. Follow it rather than guessing the shadcn API.
- **Reuse before you build.** Import existing primitives from `@cogwork/ui/components/*` and
  compose them. Never hand-roll a styled `div` when a primitive exists, and never redefine a
  primitive the UI package already ships.
- **Need a primitive the UI package doesn't have? Add it with the shadcn CLI — don't write it by
  hand.** Run the CLI from `packages/ui` so the primitive lands there:

  ```bash
  pnpm dlx shadcn@latest add <component>
  ```

  Then consume it from the desktop via `@cogwork/ui/components/<component>`. New primitives
  belong in `packages/ui`; only app-specific composites belong in `apps/desktop`. Confirm the
  registry before adding (never guess it), then read the generated file and fix any imports or icon
  usage to match this repo (`@remixicon/react`, alias `@cogwork/ui`).
- **Use semantic tokens** (`bg-background`, `text-muted-foreground`, `bg-primary`) — never raw
  colors. `className` is for layout, not for restyling primitives.
- **Compose variant styles with `cn()`, not lookup maps.** When an element's classes change by
  state (tone, outcome, active tab), put the shared base classes on the element and add each
  variant's classes as explicit `cn()` branches — duplicate the class strings per branch so you
  can see what applies where. Do not hoist variant class strings into `Record<Variant, string>`
  maps; Tailwind's own guidance treats that as the readable pattern for conditional styling.
  See [Reusing Styles](https://v3.tailwindcss.com/docs/reusing-styles).

Both `components.json` files are already wired for this: `apps/desktop` points its `ui` alias at
`@cogwork/ui`, and `packages/ui` keeps primitives local.

## React Compiler

The renderer runs with the React Compiler. Do not add manual memoization the compiler already handles
for you — no `useMemo`, `useCallback`, or `React.memo` unless you have a concrete reason the
compiler cannot (document that reason in the PR). Derive values inline during render; write event
handlers as plain functions inside the component.
