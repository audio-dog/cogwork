# Worktree Git invocation budget

Measured with `pnpm worktree:git-invocations` at commit
`24a154842cb94f20e1aed481906444053d63d6f0`. Three runs produced the same counts.

| Path | Measured | Target | Measured operations |
| --- | ---: | ---: | --- |
| Fresh ensure | 4 | 4 | `fetch`: 1, `listWorktrees`: 1, `remoteBranchExists`: 1, `addWorktree`: 1 |
| Unchanged resume | 2 | 1 | `fetch`: 1, `listWorktrees`: 1 |

Twenty percent below the measured paths is 3.2 for fresh ensure and 1.6 for unchanged resume, both
at two significant figures. Git invocations are whole operations, so an unmet resume target must be
1. That granularity makes the first step a 50% reduction instead of exactly 20%.

The unchanged-resume budget lands unmet at 2 calls against its target of 1. It expects its
unconditional `fetch` invocation to disappear but does not prescribe how. This first target retains
`listWorktrees`; only `fetch` is named for removal.

The fresh path is treated as near its current floor because no specific invocation is selected for
removal. A target of 3 would name no work, so the fresh target stays at 4. Reconsider it when a
specific invocation can be removed.
