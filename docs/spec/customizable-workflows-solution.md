## Solution

Workflows: a person's reusable automations, authored as data. A Workflow is one or more **Triggers**, the **Operations** they start, and the **Transitions** that route each Operation's typed answers to engine-owned **output actions**, a **hand-off** to the next Operation, or a **human touchpoint**. The engine observes the sources, owns the routing, performs every write, and holds every item that waits for a person.

Every author — the desktop editor, a shipped **Workflow template**, a future chat agent — writes the same schema-validated **Workflow document** through the same command RPCs. The engine runs only what a person publishes.

Cogwork ships four templates: the coding pipeline, Granola → Issue, Slack → Review, and a Staleness sweep. The fixed pipeline migrates onto this system and is deleted. **Granola → Issue is the first Workflow the build proves the engine on.**

