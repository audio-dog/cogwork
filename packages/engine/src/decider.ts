import { WorkspaceConfig, type WorkspaceEvent } from "@clanker-forge/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { RegistryState } from "./projector";

export type WorkspaceCommand =
  | { readonly type: "register-workspace"; readonly source: string; readonly module: unknown }
  | { readonly type: "record-import-failure"; readonly source: string; readonly message: string };

const decodeConfig = Schema.decodeUnknownResult(WorkspaceConfig);

const registrationFailed = (source: string, message: string): WorkspaceEvent => ({
  type: "workspace.registration-failed",
  source,
  message,
});

export const decide = (state: RegistryState, command: WorkspaceCommand): ReadonlyArray<WorkspaceEvent> => {
  if (command.type === "record-import-failure") {
    return [registrationFailed(command.source, command.message)];
  }
  const decoded = decodeConfig(command.module);
  if (Result.isFailure(decoded)) {
    return [registrationFailed(command.source, decoded.failure.message)];
  }
  const config = decoded.success;
  const conflict = state.workspaces.find((workspace) => workspace.config.name === config.name);
  if (conflict) {
    return [
      registrationFailed(
        command.source,
        `workspace "${config.name}" already registered by ${conflict.source}`,
      ),
    ];
  }
  return [{ type: "workspace.registered", source: command.source, config }];
};
