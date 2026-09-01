const preservedControls = new Set([0x09, 0x0a]);

const isDisplayable = (code: number) =>
  preservedControls.has(code) || (code > 0x1f && code < 0x7f) || code > 0x9f;

export const sanitizeTerminalText = (text: string) =>
  [...text].filter((char) => isDisplayable(char.codePointAt(0) ?? 0)).join("");

export const terminalLine = (text: string) => sanitizeTerminalText(text).replace(/[\t\n]+/g, " ");
