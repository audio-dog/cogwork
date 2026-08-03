# Engine package rules

## Linear API

Always use `@linear/sdk`'s typed `LinearClient` methods to talk to Linear — never hand-build a
GraphQL document or hit `api.linear.app` with a raw `fetch`. The one accepted exception is documented
in `src/linear/client.ts` (`rawRequest`, used for reads where the SDK's lazy nested fetching would
cost extra round trips); anything else needing the SDK for the first time should use its typed methods
(e.g. `client.viewer`, `client.organization`), not a raw request. The Linear OAuth token endpoint
(`/oauth/token`) has no SDK equivalent and is the one legitimate raw-HTTP case outside `client.ts` —
see `src/linear/oauth.ts`.
