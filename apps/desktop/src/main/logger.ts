import log from "electron-log/main";

log.initialize();

// Catch anything that slips past a handler in `main` (uncaught exceptions, unhandled
// rejections) and log it instead of tearing the process down or popping a system dialog.
log.errorHandler.startCatching({ showDialog: false });

export const logger = log;

const engineScope = log.scope("engine");

export const engineLogger = {
  info: (message: string): void => engineScope.info(message),
  warn: (message: string): void => engineScope.warn(message),
};

const mainScope = log.scope("main");

export const mainLogger = {
  info: (message: string): void => mainScope.info(message),
  warn: (message: string): void => mainScope.warn(message),
  error: (message: string, error?: unknown): void =>
    error === undefined ? mainScope.error(message) : mainScope.error(message, error),
};

const rendererScope = log.scope("renderer");

export const rendererLogger = {
  error: (message: string, detail?: unknown): void =>
    detail === undefined ? rendererScope.error(message) : rendererScope.error(message, detail),
};
