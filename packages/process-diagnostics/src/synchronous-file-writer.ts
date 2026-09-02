const { closeSync, openSync, writeFileSync } = process.getBuiltinModule("fs");

export const openSynchronousFileWriter = (path: string) => {
  const file = openSync(path, "w");
  return {
    close: () => closeSync(file),
    write: (chunk: string) => writeFileSync(file, chunk),
  };
};
