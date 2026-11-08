import { Effect, type Schema } from "effect";
import type * as Excess from "./excess.js";
import * as Inputs from "./input.js";
import * as Shapes from "./shape.js";

/** Retry only an uncovered root loss, keeping the original obligations and all earlier claims. */
export const recovery = <S extends Schema.Top>(contract: S) => {
  // Building every full permutation costs quadratic space; defer it until recovery is necessary.
  let readers: ReturnType<typeof Inputs.reorderedReaders<S>> | undefined;
  return Effect.fnUntraced(function* (
    input: Inputs.Input<S>,
    original: Inputs.Written<S["Encoded"]>,
    taken: Shapes.Taken | undefined,
    token: object,
    claim: (
      input: unknown,
      output: object,
      lost: ReadonlyArray<Excess.Path>,
    ) => ReadonlySet<PropertyKey>,
  ) {
    if (
      taken?.certificates === undefined ||
      !taken.certificates.has(token) ||
      typeof original.output !== "object" ||
      original.output === null ||
      Symbol.iterator in original.output ||
      original.lost.some((path) => path.length !== 1) ||
      original.lost.every(([name]) => taken.fields.has(name!))
    )
      return undefined;
    const alternatives = (readers ??= Inputs.reorderedReaders(contract));
    const elsewhere = Shapes.certifiedElsewhere(taken, token);
    for (const read of alternatives) {
      // Only typed schema failures permit the next attempt. Defects and interruption propagate.
      const attempt = yield* Effect.result(read(input));
      if (attempt._tag === "Failure") continue;
      const candidate = attempt.success;
      if (
        typeof candidate.output !== "object" ||
        candidate.output === null ||
        Symbol.iterator in candidate.output ||
        candidate.lost.some(
          (path) => path.length !== 1 || !elsewhere.has(path[0]!),
        )
      )
        continue;
      const next = Shapes.retaking(
        taken,
        claim(input, candidate.output, candidate.lost),
        token,
      );
      if (
        next !== undefined &&
        original.lost.every(([name]) => next.fields.has(name!))
      )
        return { reading: candidate, taken: next };
    }
    return undefined;
  });
};
