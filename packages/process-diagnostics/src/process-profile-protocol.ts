import { makeBrand } from "@cogwork/contracts";
import * as Schema from "effect/Schema";

import { ProcessProfileInput } from "./process-profiler";

export const ProcessProfileRequestId = makeBrand("ProcessProfileRequestId");
export type ProcessProfileRequestId = typeof ProcessProfileRequestId.Type;

export const ProcessProfileCapture = Schema.TaggedUnion({
  DaemonHeapSnapshot: {},
  DaemonCpuProfile: {},
  MainHeapSnapshot: {},
  MainCpuProfile: {},
});
export type ProcessProfileCapture = typeof ProcessProfileCapture.Type;

export const ProcessProfileRequest = Schema.TaggedStruct("ProcessProfileRequest", {
  requestId: ProcessProfileRequestId,
  input: ProcessProfileInput,
});
export type ProcessProfileRequest = typeof ProcessProfileRequest.Type;

export const ProcessProfileResponse = Schema.TaggedUnion({
  ProcessProfileCompleted: {
    requestId: ProcessProfileRequestId,
    path: Schema.String,
  },
  ProcessProfileFailed: {
    requestId: ProcessProfileRequestId,
    message: Schema.String,
  },
});
export type ProcessProfileResponse = typeof ProcessProfileResponse.Type;
