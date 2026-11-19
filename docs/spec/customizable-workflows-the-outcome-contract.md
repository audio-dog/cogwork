### 9. The outcome contract

- **A pure function in `@cogwork/contracts` derives each result schema from the published Operation**, beside Transition matching. One flat object, no unions, no optional fields, one shape per element: `{ summary, answers, inputs, workspace? }` where `answers` holds one required enum of choice ids per question, `inputs` holds the agent inputs, and `workspace` is present only when an action on a Transition needs one (values: the selection plus `none`). A `once` Operation returns one element at the top level plus `stuck`; a `for each` Operation returns `{ summary, stuck, elements }`. After decode the engine converts both to a list of elements. The existing path carries it: the JSON Schema rides in the Run Plan, TanStack `chat()` takes it as `outputSchema`, the external Harness runtime gets the same, and the executor decodes the one `structured-output.complete` object. (#786 item 1)

```json
{ "summary": "Three commitments; one duplicates an open issue.", "stuck": false,
  "elements": [ { "summary": "Taylor will add retry to the Slack sensor.",
                  "answers": { "match": "new" },
                  "inputs": { "issue_title": "Add retry to the Slack sensor", "issue_body": "…" },
                  "workspace": "cogwork" } ] }
```

- **Agent inputs are required strings, or a list with one engine-defined shape.** A string is empty when the element's matched Transitions do not use it; at decode the engine refuses an element whose matched Transitions need an input that is empty after trim, and ignores inputs no matched Transition uses. The one list shape is a review line comment `{ path, line, body }` on the new side of the diff (`review_comments`); decode checks each file is in the pull request's changed files and each line is in the diff. Reason: Anthropic's strict-schema limit of 16 union-typed parameters per request, and TanStack 1.0 turning each optional into a required nullable. (#786 item 2; #790 item 15)
- **Every Operation can report `stuck`.** The engine adds the required boolean to every derived schema. When true, the engine ignores the elements, records a non-retryable failure with `summary` as the reason, and parks the item for a person. (#786 item 5)
- **A decode failure (including over the 50-element cap) is a retryable failed attempt**; the retry's prompt carries the exact decode issues as data. No repair turn inside the Run. (#786 items 4, 6)
- **The failure Transition belongs to the engine; authors cannot route on it yet.** Run failure or timeout → retry while retryable → exhaustion → park with the reason → a handback clears it. An authored `onFailure` can come later as an additive field. Exhaustion adds no label; the engine posts its comment on the issue and parks as `exhausted`. (#786 item 7; #789 item 17)
- **An unhandled combination cannot occur at run time.** Decode makes each answer a declared choice, a published revision cannot change, and `uncovered-outcome` blocks publish. "Stop" is how an author says "do nothing". When several Transitions match one element, their actions join and the write key removes duplicates. (#786 item 8)
- **Retry and exhaustion are engine policy keyed by `(Workflow id, Operation id)`**: retryability from the existing policy, three consecutive failures per Operation per item, counted after the newest handback, at engine ADR 0011's composition point, for both coordination adapters. The author sets no retry count. (#786 item 9)

