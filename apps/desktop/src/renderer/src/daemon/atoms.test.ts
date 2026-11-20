import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import { boundPullChunks, pullChunkSize } from "./atoms";

const chunksOf = <A>(stream: Stream.Stream<A>) =>
  Effect.runPromise(stream.pipe(boundPullChunks, Stream.chunks, Stream.runCollect));

describe("boundPullChunks", () => {
  it("splits a replay chunk before the pull atom retains it", async () => {
    const values = Array.from({ length: pullChunkSize * 3 + 1 }, (_, index) => index);

    const chunks = await chunksOf(Stream.fromIterable(values));

    expect(chunks.map((chunk) => chunk.length)).toEqual([pullChunkSize, pullChunkSize, pullChunkSize, 1]);
    expect(chunks.flat()).toEqual(values);
  });

  it("does not delay small live chunks", async () => {
    const chunks = await chunksOf(Stream.concat(Stream.make(1), Stream.make(2)));

    expect(chunks).toEqual([[1], [2]]);
  });
});
