// A discovery probe spawns the same binary a Run does, so it must not see these either.
export const cursorScrubEnv: ReadonlyArray<string> = ["GITHUB_TOKEN", "GH_TOKEN", "CURSOR_API_KEY"];
