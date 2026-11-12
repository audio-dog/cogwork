import { ModelLevel, TrimmedNonEmptyString } from "@cogwork/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parse, YAMLParseError } from "yaml";

class SubagentFileError extends Data.TaggedError("SubagentFileError")<{
  readonly message: string;
}> {}

const SubagentFrontmatter = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z0-9-]+$/)),
  description: TrimmedNonEmptyString,
  tools: Schema.optionalKey(Schema.Union([Schema.Array(TrimmedNonEmptyString), Schema.String])),
  model: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  metadata: Schema.optionalKey(Schema.Struct({ "model-level": Schema.optionalKey(ModelLevel) })),
});
type SubagentFrontmatter = typeof SubagentFrontmatter.Type;

const decodeFrontmatter = Schema.decodeUnknownEffect(SubagentFrontmatter);

const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

interface DecodedFile {
  readonly localName: string;
  readonly frontmatter: SubagentFrontmatter;
  readonly prompt: string;
}

const rejections: ReadonlyArray<{
  readonly rejects: (file: DecodedFile) => boolean;
  readonly reason: (file: DecodedFile) => string;
}> = [
  {
    rejects: ({ localName, frontmatter }) => frontmatter.name !== localName,
    reason: ({ localName, frontmatter }) =>
      `name "${frontmatter.name}" does not match the file name "${localName}"`,
  },
  {
    rejects: ({ frontmatter }) => "model" in frontmatter && !inheritsModel(frontmatter.model),
    reason: ({ frontmatter }) =>
      `model ${JSON.stringify(frontmatter.model)} is a vendor model, not a Model level; write metadata.model-level (light, standard, or deep)`,
  },
  {
    rejects: ({ prompt }) => prompt.length === 0,
    reason: () => "the body has no prompt",
  },
];

const inheritsModel = (model: string | null | undefined) => model === null || model === "inherit";

const yamlProblem = (error: unknown) => {
  if (!(error instanceof YAMLParseError)) return "the frontmatter is not valid YAML";
  const line = error.linePos?.[0].line;
  return line === undefined
    ? `the frontmatter is not valid YAML (${error.code})`
    : `the frontmatter is not valid YAML (${error.code} at line ${line})`;
};

const singleLine = (message: string) => message.replace(/\s+/g, " ").trim();

const toolList = (tools: SubagentFrontmatter["tools"]) =>
  typeof tools === "string"
    ? tools
        .split(",")
        .map((tool) => tool.trim())
        .filter((tool) => tool.length > 0)
    : (tools ?? []);

const rejected = (message: string) => new SubagentFileError({ message });

export const decodeSubagentFile = Effect.fn("SubagentFile.decode")(function* (
  localName: string,
  text: string,
) {
  const sections = frontmatterPattern.exec(text);
  if (sections === null) return yield* rejected("the file has no YAML frontmatter");
  const [, yaml = "", body = ""] = sections;
  const raw = yield* Effect.try({
    try: () => parse(yaml),
    catch: (error) => rejected(yamlProblem(error)),
  });
  const frontmatter = yield* decodeFrontmatter(raw).pipe(
    Effect.mapError((error) => rejected(`the frontmatter does not decode: ${singleLine(error.message)}`)),
  );
  const file = { localName, frontmatter, prompt: body.trim() };
  const rejection = rejections.find(({ rejects }) => rejects(file));
  if (rejection !== undefined) return yield* rejected(rejection.reason(file));
  return {
    description: frontmatter.description,
    tools: toolList(frontmatter.tools),
    modelLevel: frontmatter.metadata?.["model-level"] ?? "standard",
    prompt: file.prompt,
  };
});
