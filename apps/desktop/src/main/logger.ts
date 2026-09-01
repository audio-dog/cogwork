import * as Logger from "effect/Logger";
import log from "electron-log/main";

log.initialize();

// Catch anything that slips past a handler in `main` (uncaught exceptions, unhandled
// rejections) and log it instead of tearing the process down or popping a system dialog.
log.errorHandler.startCatching({ showDialog: false });

export const logger = log;

const engineScope = log.scope("engine");

const writeEngineLog = (entry: ReturnType<typeof Logger.formatStructured.log>) => {
  if (entry.level === "ERROR" || entry.level === "FATAL") return engineScope.error(entry);
  if (entry.level === "WARN") return engineScope.warn(entry);
  if (entry.level === "DEBUG" || entry.level === "TRACE") return engineScope.debug(entry);
  return engineScope.info(entry);
};

const engineEffectLogger = Logger.make((options) => writeEngineLog(Logger.formatStructured.log(options)));

export const engineLoggerLayer = Logger.layer([engineEffectLogger], { mergeWithExisting: true });

const mainScope = log.scope("main");

export const mainLogger = {
  info: (message: string) => mainScope.info(message),
  warn: (message: string) => mainScope.warn(message),
  error: (message: string, error?: unknown) =>
    error === undefined ? mainScope.error(message) : mainScope.error(message, error),
};

const rendererScope = log.scope("renderer");

export const rendererLogger = {
  error: (message: string, detail?: unknown) =>
    detail === undefined ? rendererScope.error(message) : rendererScope.error(message, detail),
};
