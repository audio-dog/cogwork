import { Option } from "effect";

export const ready = Option.some("value").pipe(Option.map(() => true));
