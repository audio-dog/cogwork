// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createReadStream, createWriteStream } from "node:fs";

export const profileFdStreams = () => ({
  requests: createReadStream("", { fd: 3 }),
  responses: createWriteStream("", { fd: 4 }),
});
