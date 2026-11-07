import { Effect, Schema } from "effect";

/** What a schema-backed input takes: what the schema's own constructor takes. */
export type Input<S extends Schema.Top> = S["~type.make.in"];

/** Build the schema's value from an input, so a plain object works for a class. */
export const toDecoded =
  <S extends Schema.Top>(contract: S) =>
  (input: Input<S>): Effect.Effect<S["Type"], Schema.SchemaError> =>
    Effect.mapError(
      contract.makeEffect(input),
      (issue) => new Schema.SchemaError(issue),
    );

/** Build the schema's value, then write it. */
export const encoder = <S extends Schema.Top, A, R>(
  contract: S,
  write: (value: S["Type"]) => Effect.Effect<A, Schema.SchemaError, R>,
) => {
  const decoded = toDecoded(contract);
  return (input: Input<S>): Effect.Effect<A, Schema.SchemaError, R> =>
    Effect.flatMap(decoded(input), write);
};
