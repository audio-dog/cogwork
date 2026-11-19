### 18. Build facts to confirm before the pull request that depends on them

- Granola MCP `list_meetings` returns an updated time (B6). Confirmed: it returns `updated_at` when the call sets `updated_after`; the output shape is on [#806](https://github.com/taylorfsteele/cogwork/issues/806#issuecomment-6502498876).
- A Slack user token works with `mcp.slack.com` (Slack). Confirmed: the token from "Sign in with Slack" passes `initialize`, `tools/list`, and a read call; the Socket Mode fact is dropped because Slack is polled. Evidence is on [#805](https://github.com/taylorfsteele/cogwork/issues/805#issuecomment-6503753986).
- `chat.postMessage` metadata reads back through `conversations.history` and `conversations.replies` (Slack write keys). Confirmed on [#805](https://github.com/taylorfsteele/cogwork/issues/805#issuecomment-6503753986), for a post and a thread reply made as the person.
- A `pushurl` set for one worktree works (B5).
- GitHub pending reviews (no `event`) through the API, for "Draft a review".
- OS notifications: a cold-start click opens the item on macOS 26; a clean quit removes delivered notifications; Windows behaviour; test on a signed `build:unpack`, not the dev `Electron.app`.
- The edit round-trip latency budget (ADR 0023).

