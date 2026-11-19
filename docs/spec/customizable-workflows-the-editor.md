### 13. The editor

Settled in [Prototype: Workflow authoring UI](https://github.com/taylorfsteele/cogwork/issues/658) and landed on mock data in [#777](https://github.com/taylorfsteele/cogwork/pull/777): a Workflows list whose rows open onto Triggers, Operations, and where each answer leads; an editor with a header, a Triggers section fed by a cascading, filterable catalog menu, and one card per Operation with its instruction, provider picker, and outcomes (every time ▸ actions; question ▸ each answer ▸ actions, hint, hand-off; combinations; "Unhandled"). The grills change the prototype as follows, and the wiring work applies them:

- The header's Save becomes **Publish**; the editor is a live view of the working copy (no local draft); the on/off switch is a separate command, not a field. Field text stays local while typing and sends one edit on pause or blur.
- **Routes become Transitions**; a Transition's identity is its answers (array of pairs, not a map); hints move to `{ field, text }`; catalog references become keys plus parameters; each Trigger names its start Operation and the first-Operation ordering convention goes; the list orders Operations along the hand-off path, then the unreached ones (advisory `unreachable-operation`).
- The Operation card gains the **permission profile**, **Requires** (replacing the Tools placeholder), **for each ⟨finding⟩**, **model options**, and **instruction package**.
- The catalog menu is **app-first**; the `connectorOnly` separator becomes `requires` plus `availability`; every option list comes from `listOptions`. Granola's "Meeting ended" and the Webhook group go; Slack's entries are the three in §7.
- The coding example drops the triage → implement and implement → follow-up hand-offs and adds the `ready-for-agent` and follow-up Triggers; "Notify me" gives way to "Hand to me" where the pipeline hands an item to the person.
- Diagnostics render at their node by class; `hand-off-and-trigger` reads "X will run two times".
- The Workflows page shows the templates when the person has no Workflows.

