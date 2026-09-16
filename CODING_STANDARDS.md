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

- Make each type as narrow as the values it holds. A widened type is the same refusal as `as any`:
  it makes the type check pass without correcting the type.
- Do not widen a type to make an assignment work. If a value is one of a known set, the type is
  that set. `string` is correct only for a value that a person types or an external system sends,
  and never for a set this repository chooses.
- Do not write `"a" | "b" | (string & {})`. That union widens to `string`, so the type accepts
  every string and only the editor still sees `"a"` and `"b"`. Either the set is closed and the
  union is the type, or it is open and `string` is the type.
- If one field holds both a closed set and an open value, they are two kinds. Name each one, and
  wrap the open one: `"model" | "effort" | { readonly modelOption: string }`. See
  `HarnessSelectionAxis` in `packages/engine/src/harness.ts`.
- Do not take `unknown` or `object` for a value this repository built. Take the union it belongs
  to, and narrow it at the one boundary that decodes it.
- Do not replace a named type with its shape to escape a mismatch. `ReadonlyArray<{ value: string }>`
  in place of `ReadonlyArray<HarnessCatalogChoice>` accepts anything with a `value`, so the next
  caller passes the wrong thing and the type check agrees. Name the union of what the function
  really takes.
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
