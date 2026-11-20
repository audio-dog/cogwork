### 15. The validation cases, expressed

The map required the design to express these. Each is checked against the document in §2 and the catalog in §10.

- **Granola → Issue** — the template above. Exercises: an engine-minted item, fan-out, the `workspace` element answer, the reconcile question, the issue search Tool, composition into the coding pipeline through `needs-triage`.
- **Slack → Review** — the template above. Exercises: the Slack Trigger source, "I am mentioned", a hand-off whose next Operation reads a different artifact (the message → the pull request it names, through the pull request Tool and the `pull_request` input), review events as author parameters, line comments as a list input, approval holding a plan, plan withdrawal on new commits.
- **PR Merged → Verify** — not shipped as a template (a wrong "remainder" issue costs trust; `product.md`: precision over recall), but expressible: a pull request state Trigger with parameter `merged` (occurrence; revision = merge time; the item is the linked issue, found by link key) → **Verify**, `result: fulfilled | outstanding`, inputs `issue_title`, `issue_body`, `comment`: `fulfilled` → Close this issue; `outstanding` → Create an issue, Comment on this item. The deterministic-engine-step slot the map names is the future Step node in §2; what fills it is a separate effort.
- **Staleness sweep** — the template above; Feldspar's "the world moved on while parked", with the agent breaking ties and the engine doing the selection.
- **Scheduled digest** (Feldspar E) — expressible with a schedule Trigger, a `worth: publish | withhold` question, and Send a message, but not shipped: no ticket or validation case asks for it.
- **Feldspar shapes that do not fit** and are not in the design: frontmost-app triggers, screen capture as context, autonomous graph curation, the living knowledge layer. ([Research: Feldspar workflow ideas](https://github.com/taylorfsteele/cogwork/issues/657))

