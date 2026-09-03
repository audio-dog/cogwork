import { AgUiEvent } from "@cogwork/contracts";
import * as Schema from "effect/Schema";

export const encodeStoredRunEvent = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
export const decodeStoredRunEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(AgUiEvent));
