# 0039 — Local UI state is Effect Atom state

- **Status:** accepted
- **Date:** 2026-11-19
- **Amends:** ADR [0009](./0009-mission-control-ui-client-stack.md)

## Context

ADR 0009 put server state in `AtomRpc` and `@effect/atom-react`, and local shell chrome in zustand.
In practice the desktop app holds state in four ways: `useState`, zustand stores, hand-written
`useSyncExternalStore` stores, and Atoms. An agent picks one at random, and often syncs a
`useState` with a `useEffect`. We already ban `useEffect` in the desktop app.

## Decision

All React state outside `packages/ui` is Effect Atom state, read through `@effect/atom-react`. The
lint rule `no-react-state` (from `@shekohex/oxc-effect`) is an error in every file except
`packages/ui/**`. It bans `useState`, `useReducer`, `useContext`, `useCallback`, `useEffect`, and
`useSyncExternalStore`. The zustand stores become atoms, and zustand is removed. State that belongs
to one component instance uses `Atom.family`, keyed by that instance. `packages/ui` keeps React state
for its primitives, and `theme-provider.tsx` moves into it.

## Considered Options

- **Keep `useState` for short-lived component state.** Rejected: it leaves two models, and the
  `useState` plus `useEffect` sync is the agent mistake we want to make impossible.
- **Ban the hooks but keep zustand.** Rejected: zustand would stay a legal second store, and agents
  would use it to avoid the ban.

## Consequences

- Trivial state, such as a search query or an open dialog, takes more code. An atom that is not
  keyed per instance is shared between instances. A test or a review catches this; the lint rule
  does not.
- The rule bans hooks by name. `useRef`, `useTransition`, `useOptimistic`, and `useActionState` stay
  legal, so the rule can be avoided. This is a known gap.
- An atom is disposed when no component reads it (`keepAlive` is false by default), so local state
  resets on unmount, the same as `useState`.
