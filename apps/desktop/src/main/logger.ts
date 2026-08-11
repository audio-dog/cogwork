import log from "electron-log/main";

log.initialize();

export const logger = log;

const engineScope = log.scope("engine");

export const engineLogger = {
  info: (message: string): void => engineScope.info(message),
  warn: (message: string): void => engineScope.warn(message),
};
