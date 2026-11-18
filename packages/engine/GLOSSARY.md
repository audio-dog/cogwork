# Engine (orchestration runtime)

The work control plane packaged as an embeddable library — the machinery that discovers, schedules,
and runs work. It owns the *verbs*; the nouns live in the shared kernel
([contracts](../contracts/GLOSSARY.md)). It has no process identity of its own; the daemon hosts it.

Role in the flow: **observe → schedule → run → dispatch to a harness**. See the root
`GLOSSARY-MAP.md` for the end-to-end story.

## Language

Each file below holds one group of terms. Find a term in this list, then read its file.

- [Daemon and scheduling](./GLOSSARY-daemon.md): **Daemon**, **Trigger observation**, **Rate-limit scope**, **Cooldown window**, **Ready-to-merge view**, **Assignee ownership gate**, **Scheduler**, **Drain**, **Crash recovery**, **Candidate**
- [Runs](./GLOSSARY-runs.md): **Workflow runner**, **Run preparation**, **Run completion**, **Run recorder**, **Session store**, **Operating-instructions package**, **Run Plan resolution**, **Action entry**, **Refused result**, **Resource reference**, **Harness switch**
- [Triggers](./GLOSSARY-triggers.md): **Catch-up window**, **Quiet period**, **Sweep**
- [Coding pipeline](./GLOSSARY-coding-pipeline.md): **Requirements digest**, **Review requirements**
- [Harness](./GLOSSARY-harness.md): **Harness request**, **Harness service**, **Harness runner**, **Harness capability profile**, **External Harness runtime**, **Harness Workspace projection**, **Skills supply**, **MCP server assembler**, **Context assembler**, **Instruction layer**
- [Sandbox and tools](./GLOSSARY-sandbox.md): **Owned tool set**, **Worktree sandbox**, **Path confinement**, **File-diff feed**, **Policy profile**, **Ask-compiles-to-deny**, **Hard-deny rule**
- [Adapters and credentials](./GLOSSARY-adapters.md): **Issue tracker adapter**, **Tracker Trigger source**, **Source control provider adapter**, **Credential store**, **Provider key**, **Supported providers**, **Model catalog**, **Model adapter resolution**, **Token refresh**, **Client-credentials grant**, **Stored credential**
- [Coordination and worktrees](./GLOSSARY-coordination.md): **Coordination module**, **Park notice**, **Worktree manager**, **Branch divergence**, **Base divergence**, **Workspace registry**, **Refused claim**, **Round summary**
- [Performance](./GLOSSARY-performance.md): **Telemetry store**, **Performance regression sensor**, **Performance verdict**, **Performance issue filer**, **Performance budget sensor**, **Performance budget**, **Replay runner**, **Health signal**, **Fingerprint**
