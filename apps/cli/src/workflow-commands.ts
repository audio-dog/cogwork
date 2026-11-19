import { WorkflowDocument, WorkflowEditBatch, WorkflowId } from "@cogwork/contracts";
import * as Console from "effect/Console";
import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { defaultSocketPath } from "./paths";
import { clientLayer, makeDaemonClient } from "./rpc";
import { terminalLine } from "./terminal-text";

const socketFlag = Flag.String("socket").pipe(
  Flag.withDescription("Path to the daemon control socket"),
  Flag.withDefault(defaultSocketPath),
);

const documentArgument = Argument.String("document-json");
const templateIdArgument = Argument.String("template-id");
const editsArgument = Argument.String("edits-json");
const idArgument = Argument.String("id");
const revisionArgument = Argument.Int("revision");
const switchArgument = Argument.Literals("state", ["on", "off"]);

const inputError = (label: string, cause: unknown) =>
  new CliError.UserError({ cause, userMessage: terminalLine(`Invalid ${label} JSON`) });

const decodeDocument = (input: string) =>
  Schema.decodeEffect(Schema.fromJsonString(WorkflowDocument), { onExcessProperty: "error" })(input).pipe(
    Effect.mapError((error) => inputError("Workflow document", error)),
  );

const decodeUnknown = (input: string) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(input).pipe(
    Effect.mapError((error) => inputError("Workflow document", error)),
  );

const decodeEdits = (input: string) =>
  Schema.decodeEffect(Schema.fromJsonString(WorkflowEditBatch), { onExcessProperty: "error" })(input).pipe(
    Effect.mapError((error) => inputError("Workflow edits", error)),
  );

const decodeId = (input: string) =>
  Schema.decodeEffect(WorkflowId)(input).pipe(Effect.mapError((error) => inputError("Workflow id", error)));

const printJson = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

const withClient = <A, E, R>(socket: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(clientLayer(socket)));

const create = ({ socket, documentJson }: { readonly socket: string; readonly documentJson: string }) =>
  withClient(
    socket,
    Effect.gen(function* () {
      const document = yield* decodeDocument(documentJson);
      const client = yield* makeDaemonClient();
      yield* printJson(yield* client.CreateWorkflow({ document }));
    }),
  );

const createTemplate = ({ socket, templateId }: { readonly socket: string; readonly templateId: string }) =>
  withClient(
    socket,
    Effect.gen(function* () {
      const client = yield* makeDaemonClient();
      const template = (yield* client.GetWorkflowTemplates()).find(({ id }) => id === templateId);
      if (!template) {
        return yield* new CliError.UserError({
          cause: templateId,
          userMessage: terminalLine(`Unknown Workflow template ${templateId}`),
        });
      }
      yield* printJson(yield* client.CreateWorkflow({ document: template.document }));
    }),
  );

const edit = (options: { readonly socket: string; readonly id: string; readonly editsJson: string }) =>
  withClient(
    options.socket,
    Effect.gen(function* () {
      const id = yield* decodeId(options.id);
      const edits = yield* decodeEdits(options.editsJson);
      const client = yield* makeDaemonClient();
      yield* printJson(yield* client.EditWorkflow({ id, edits }));
    }),
  );

const publish = (options: { readonly socket: string; readonly id: string; readonly revision: number }) =>
  withClient(
    options.socket,
    Effect.gen(function* () {
      const id = yield* decodeId(options.id);
      const client = yield* makeDaemonClient();
      yield* printJson(yield* client.PublishWorkflow({ id, revision: options.revision }));
    }),
  );

const switchWorkflow = (options: {
  readonly socket: string;
  readonly id: string;
  readonly state: "on" | "off";
}) =>
  withClient(
    options.socket,
    Effect.gen(function* () {
      const id = yield* decodeId(options.id);
      const client = yield* makeDaemonClient();
      yield* printJson(yield* client.SwitchWorkflow({ id, enabled: options.state === "on" }));
    }),
  );

const deleteWorkflow = (options: { readonly socket: string; readonly id: string }) =>
  withClient(
    options.socket,
    Effect.gen(function* () {
      const id = yield* decodeId(options.id);
      const client = yield* makeDaemonClient();
      yield* printJson(yield* client.DeleteWorkflow({ id }));
    }),
  );

const list = ({ socket }: { readonly socket: string }) =>
  withClient(
    socket,
    Effect.gen(function* () {
      const client = yield* makeDaemonClient();
      yield* printJson(yield* client.ListWorkflows());
    }),
  );

const get = (options: { readonly socket: string; readonly id: string }) =>
  withClient(
    options.socket,
    Effect.gen(function* () {
      const id = yield* decodeId(options.id);
      const client = yield* makeDaemonClient();
      yield* printJson(yield* client.GetWorkflow({ id }));
    }),
  );

const validate = ({ socket, documentJson }: { readonly socket: string; readonly documentJson: string }) =>
  withClient(
    socket,
    Effect.gen(function* () {
      const document = yield* decodeUnknown(documentJson);
      const client = yield* makeDaemonClient();
      yield* printJson(yield* client.ValidateWorkflow({ document }));
    }),
  );

const catalog = ({ socket }: { readonly socket: string }) =>
  withClient(
    socket,
    Effect.gen(function* () {
      const client = yield* makeDaemonClient();
      yield* printJson(yield* client.GetWorkflowCatalog());
    }),
  );

const templates = ({ socket }: { readonly socket: string }) =>
  withClient(
    socket,
    Effect.gen(function* () {
      const client = yield* makeDaemonClient();
      yield* printJson(yield* client.GetWorkflowTemplates());
    }),
  );

const createCommand = Command.make("create", { socket: socketFlag, documentJson: documentArgument }).pipe(
  Command.withHandler(create),
);
const createTemplateCommand = Command.make("create-template", {
  socket: socketFlag,
  templateId: templateIdArgument,
}).pipe(Command.withHandler(createTemplate));
const editCommand = Command.make("edit", {
  socket: socketFlag,
  id: idArgument,
  editsJson: editsArgument,
}).pipe(Command.withHandler(edit));
const publishCommand = Command.make("publish", {
  socket: socketFlag,
  id: idArgument,
  revision: revisionArgument,
}).pipe(Command.withHandler(publish));
const switchCommand = Command.make("switch", {
  socket: socketFlag,
  id: idArgument,
  state: switchArgument,
}).pipe(Command.withHandler(switchWorkflow));
const deleteCommand = Command.make("delete", { socket: socketFlag, id: idArgument }).pipe(
  Command.withHandler(deleteWorkflow),
);
const listCommand = Command.make("list", { socket: socketFlag }).pipe(Command.withHandler(list));
const getCommand = Command.make("get", { socket: socketFlag, id: idArgument }).pipe(Command.withHandler(get));
const validateCommand = Command.make("validate", {
  socket: socketFlag,
  documentJson: documentArgument,
}).pipe(Command.withHandler(validate));
const catalogCommand = Command.make("catalog", { socket: socketFlag }).pipe(Command.withHandler(catalog));
const templatesCommand = Command.make("templates", { socket: socketFlag }).pipe(
  Command.withHandler(templates),
);

export const workflowCommand = Command.make("workflow").pipe(
  Command.withDescription("Create, edit, publish, switch, inspect, and delete Workflows"),
  Command.withSubcommands([
    createCommand,
    createTemplateCommand,
    editCommand,
    publishCommand,
    switchCommand,
    deleteCommand,
    listCommand,
    getCommand,
    validateCommand,
    catalogCommand,
    templatesCommand,
  ]),
);
