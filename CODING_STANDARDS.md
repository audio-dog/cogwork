# Coding standards

These are the code rules that `biome check` cannot test. Check each rule against each changed file. A
change that breaks one rule is not ready for review.

Other documents hold the other rules:

- `docs/agent-patterns/` — the Effect patterns.
- `AGENTS.md` — the Control store and skill loading.
- `apps/desktop/AGENTS.md` — the design system, Tailwind, and the React Compiler.
- `CONTEXT-MAP.md` and each `CONTEXT.md` — the domain words.

## Suppressions

- Correct the types to make the type check pass. Do not use `as any`, `@ts-ignore`, or
  `@ts-expect-error`.
- Each lint rule prevents a known problem. The files in `configs/lint/` give the reason in the
  message.
- If a lint rule gives the wrong result, read the reason first. Then write a new rule that tests the
  correct condition.
- Do not suppress a lint rule. Do not make its condition more narrow. Do not delete it.
- `no-use-effect.grit` permits an inline suppression. Do not use that suppression. See
  [React](#react).

## Comments

- Give each function, variable, and type a name that shows its purpose.
- Write a comment only for a constraint that the code does not show. Examples: the contract of an
  external system, a necessary sequence of steps, or a correction that a later reader can remove by
  mistake.
- Do not write a comment that tells what the code does.
- Do not write a comment that records a change.
- Put the reason for a change in the commit message or the pull request body.
- `configs/lint/jsx.grit` shows the correct form. It gives the reason for its rule, and the command
  that makes its tables again after an upgrade.

## Commit messages

- Write the subject as a [Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/):
  `type(scope): summary`. The scope is optional. Add `!` before the colon for a breaking change.
- `pnpm install` installs a `commit-msg` hook that rejects a subject in another form. The hook reads
  `.pre-commit-config.yaml` and runs in the main checkout and in each linked worktree.
- Put the reason for the change in the body, under a blank line.

## Control flow

- Return early from a function. Use a guard clause at the start, not an `else` block at the end.
- Do not put a ternary operator in another ternary operator. Move the condition into a function with
  a name.
- Use optional chaining or an optional call in place of two checks. `getter?.()` tests an absent
  getter and an empty result together.
- If the same branch occurs twice, move it into one function. Call that function from both places.
- Reduce nested branches when you find them. Do not wait for a request.
- Effect pipelines have more rules. `no-effect-ladder.grit`, `no-flatmap-ladder.grit`, and
  `member-calls.grit` test them.

## TypeScript

- Let TypeScript infer the return type of a component, a hook, a helper, or a normal function.
- Write an explicit return type only for an overload, a recursive function, a generic inference
  boundary, or a requirement of the type check.
- Declare each variable with `const`. Calculate the result from the available values.
- Do not declare a variable with `let` and then change it in a branch.
- Put a type in the file that uses or implements it, and export the type from that file.
- Do not make a `types.ts` file.
- Do not write `void` before a call. Write it only if a lint rule requires it.

## Time

- Use `Effect.sleep`, `Effect.timeout`, `Schedule`, or `Stream` in Effect code. These show the
  purpose of the delay, and `TestClock` controls them in a test. See
  `docs/agent-patterns/effect-time-bounds.md`.
- Use a hook from `react-use` or `@react-hookz/web` in React code.
- Do not call `setTimeout` or `setInterval`.

## React

`.agents/skills/react-composition-patterns` tells you how to compose a component. The rules below
tell you what a reviewer rejects. Load the skill before you change the structure of a component.

- Calculate a value during the render, do the work in an event handler, reset the state with the
  `key` prop, or read a store.
- Do not write a `useEffect` hook. If a component seems to need one, change the design of the
  component. The `/react-no-use-effect` skill gives the alternatives.
- Make a separate component for each variant, then compose them. Do not add a boolean prop that
  selects what a component renders. Examples: `isThread`, `isEditing`.
- Pass `children`. Do not add a `renderHeader`, `renderFooter`, or other `renderX` prop for static
  content.
- Make a complex component a compound component. Put its state in a provider. Give the provider a
  context with the fields `state`, `actions`, and `meta`. Each child component then reads the state
  directly.
- Do not pass a prop through an intermediate component to reach a child.
- Pass `ref` as a normal prop. React 19 permits this. Do not use `forwardRef`.
- Read a context with `use()`. Do not call `React.useContext`. The primitives that the shadcn CLI
  generates in `packages/ui` keep `React.useContext`.
- Compose a primitive from `@cogwork/ui/components/*` directly. Do not make a local wrapper
  component that only passes its props to one primitive.
