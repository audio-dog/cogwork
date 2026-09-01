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

## Looking at the running app

**Never load the renderer in a browser.** `electron-vite dev` serves it at `http://localhost:5173`,
so a browser tool can reach it — but that page has no preload script. `window.cogwork` is
`undefined` there, so the app shows no engine status and has no RPC to the daemon socket. What you
see is a dead shell, not the app.

Attach to the real Electron window over the Chrome DevTools Protocol instead.

1. **A human starts the app, never you** — the root `AGENTS.md` rule applies here in full. The
   command they run is:

   ```bash
   REMOTE_DEBUGGING_PORT=9333 pnpm --filter @cogwork/desktop dev
   ```

   `electron-vite` reads `REMOTE_DEBUGGING_PORT` and appends the switch to the Electron process, so
   nothing in `src/main` needs to change, and the port stays closed whenever the variable is unset.
   It is 9333 rather than the Chrome default 9222 because a developer's own Chrome debugging profile
   usually holds 9222; the app would then fail to bind, and the attach would land on Chrome without
   saying so.

   Check before you attach: `curl -s http://127.0.0.1:9333/json/version` names the Electron build
   when the app is up with the port open. If it does not answer, ask for the app and wait. Starting
   it yourself refocuses someone's window and attaches you to nothing.

2. Use the `cogwork-app` MCP server. It runs `chrome-devtools-mcp` against `http://127.0.0.1:9333`
   and gives you `list_pages`, `take_snapshot`, `take_screenshot`, `click`, `evaluate_script`, and
   the console and network readers — all against the live window, with the preload bridge intact.

   It is declared once per harness, in each harness's own project scope: `<repo>/.mcp.json` for
   Claude Code, `<repo>/.codex/config.toml` for Codex. Keep the two in step. A third harness needs
   its own file — there is no shared location, and `.agents/` is not one: nothing scans that tree
   for an MCP server yet.

   `.mcp.json` cannot move into `.claude/`. Project scope is that one path, no setting relocates it,
   and the `.claude` directory reference states the constraint outright: "Lives at the project root,
   not inside `.claude/`".

`chrome-devtools-mcp` supports Chrome officially, not Electron. It works here because Electron 43
ships Chromium 150, well clear of the Chromium 144 floor that its `Target.getDevToolsTarget` call
needs ([issue #1197](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1197)). If an
Electron downgrade ever breaks the attach, that is the cause — fix the floor, and do not swap in one
of the single-author Electron MCP forks.

For a check that must run with no human-started app (CI, a `tester` agent), drive a built app with
Playwright's [`_electron`](https://playwright.dev/docs/api/class-electron) API against
`out/main/index.js`. That harness is not set up yet.
