const { closeSync, fchmodSync, openSync, writeFileSync } = process.getBuiltinModule("fs");

export const openSynchronousFileWriter = (path: string) => {
  const file = openSync(path, "w", 0o600);
  fchmodSync(file, 0o600);
  return {
    close: () => closeSync(file),
    write: (chunk: string) => writeFileSync(file, chunk),
  };
};
