import { toolDefinition } from "@tanstack/ai";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { IssueTrackerService } from "./issue-tracker";
import type { RegisteredWorkspace } from "./projector";

const IssueSearchInput = Schema.Struct({ query: Schema.String });
const inputSchema = Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(IssueSearchInput));

const matchesQuery = (query: ReadonlyArray<string>, text: string) => {
  const candidate = text.toLocaleLowerCase();
  return query.every((term) => candidate.includes(term));
};

export const makeIssueSearchTool = (
  tracker: IssueTrackerService,
  workspaces: ReadonlyArray<RegisteredWorkspace>,
) => {
  const search = Effect.fn("IssueSearchTool.search")(function* ({ query }: typeof IssueSearchInput.Type) {
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const byWorkspace = yield* Effect.forEach(workspaces, (workspace) =>
      tracker.observe(workspace).pipe(
        Effect.flatMap((items) =>
          Effect.forEach(items, (item) =>
            tracker.readProse(workspace, item.id).pipe(
              Effect.map(({ body }) => ({
                workspace: workspace.config.name,
                id: item.id,
                title: item.title,
                url: item.url,
                body,
              })),
            ),
          ),
        ),
      ),
    );
    const matches = byWorkspace.flat().filter(({ title, body }) => matchesQuery(terms, `${title}\n${body}`));
    return { matches };
  });

  return toolDefinition({
    name: "issue-search",
    description: "Search issues in the Workflow's selected Workspaces. This tool is read-only.",
    inputSchema,
  }).server((input) => Effect.runPromise(search(input)));
};
