import { it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import { outcome, wireCases } from "../clients/post-release-wire.js";
import { assertWireCase } from "./post-release-wire-assertions.js";

// Keep the catalogue IDs visible to the catalogue's source check.
const groups = {
  "52a": "[EXT-52a]",
  "52b": "[EXT-52b]",
  "52c": "[EXT-52c]",
  "53a": "[EXT-53a]",
  "53b": "[EXT-53b]",
  "53c": "[EXT-53c]",
  "53d": "[EXT-53d]",
  "54a": "[EXT-54a]",
  "54b": "[EXT-54b]",
  "55a": "[EXT-55a]",
  "55b": "[EXT-55b]",
  "55c": "[EXT-55c]",
  "55d": "[EXT-55d]",
  "57a": "[EXT-57a]",
  "57b": "[EXT-57b]",
  "58": "[EXT-58]",
  "59": "[EXT-59]",
  "60": "[EXT-60]",
  "61": "[EXT-61]",
  "62": "[EXT-62]",
  "63": "[EXT-63]",
} as const;

for (const id of Object.keys(groups) as Array<keyof typeof groups>) {
  for (const row of wireCases[id]) {
    it.live(`${groups[id]} ${row.name}`, () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("echo", undefined, {
          listener: "socket",
        });
        const result = yield* outcome(row.send, backend.origin).pipe(
          Effect.provide(lane.fetchClient),
        );
        assertWireCase(row.expected, result, yield* backend.ledger);
      }),
    );
  }
}
