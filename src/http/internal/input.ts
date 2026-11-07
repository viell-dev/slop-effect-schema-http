import { Effect, Schema, SchemaAST } from "effect";

/** What a schema's constructor takes. This is the one place that names the `~`-prefixed key. */
type ConstructorInput<S extends Schema.Top> = S["~type.make.in"];

/** A field's type on the encoded side, in whichever union members have it. */
type EncodedField<B, K> = B extends unknown
  ? K extends keyof B
    ? B[K]
    : never
  : never;

/** Either side of a schema, chosen field by field. A list is a value, so it has no fields. */
type Fieldwise<A, B> =
  A extends ReadonlyArray<unknown>
    ? never
    : A extends object
      ? { readonly [K in keyof A]: A[K] | EncodedField<B, K> }
      : never;

type EitherSide<A, B> = [A, B] extends [B, A] ? A : A | B | Fieldwise<A, B>;

/** What a schema-backed input takes: its decoded side, its encoded side, or a mix by field. */
export type Input<S extends Schema.Top> = EitherSide<
  ConstructorInput<S>,
  S["Encoded"]
>;

/** The fields of a struct or class, as they are declared, with each field's own encoding. */
const fieldsOf = (
  ast: SchemaAST.AST,
): ReadonlyArray<{
  readonly name: PropertyKey;
  readonly type: SchemaAST.AST;
}> =>
  ast._tag === "Objects"
    ? ast.propertySignatures
    : ast._tag === "Declaration" && ast.encoding !== undefined
      ? fieldsOf(ast.encoding[0].to)
      : [];

/**
 * Bring a value on either side of a schema to its decoded side.
 *
 * @remarks
 * A value that fits the decoded side is read as decoded, so it is encoded once. Anything else goes
 * through the decoder as a whole, then field by field. Both routes validate, and a value that fits
 * neither fails with the decoded side's error, so existing failures read the same.
 */
export const toDecoded = <S extends Schema.Top>(contract: S) => {
  const make = (input: unknown) =>
    Effect.mapError(
      contract.makeEffect(input),
      (issue) => new Schema.SchemaError(issue),
    );
  const decode = Schema.decodeUnknownEffect(contract);
  const byField = Effect.fnUntraced(function* (input: object) {
    const output: Record<PropertyKey, unknown> = { ...input };
    for (const { name, type } of fieldsOf(contract.ast))
      if (output[name] !== undefined)
        output[name] = yield* fromPart(type, output[name]);
    return yield* make(output);
  });
  const byMember = (input: object) =>
    contract.ast._tag === "Union"
      ? Effect.firstSuccessOf(
          contract.ast.types.map((member) => fromPart(member, input)),
        )
      : byField(input);
  return (
    input: Input<S>,
  ): Effect.Effect<S["Type"], Schema.SchemaError, S["DecodingServices"]> =>
    Effect.catch(make(input), (failure) =>
      Effect.mapError(
        Effect.catch(decode(input), (encodedFailure) =>
          typeof input === "object" && input !== null
            ? byMember(input)
            : Effect.fail(encodedFailure),
        ),
        () => failure,
      ),
    ) as Effect.Effect<S["Type"], Schema.SchemaError, S["DecodingServices"]>;
};

/** Read a field or union member, which may be on either side of its own schema. */
const fromPart = (ast: SchemaAST.AST, value: unknown) =>
  toDecoded(Schema.make<Schema.Top>(ast))(value);

/** Bring a value to the schema's decoded side, then write it. */
export const encoder = <S extends Schema.Top, A, R>(
  contract: S,
  write: (value: S["Type"]) => Effect.Effect<A, Schema.SchemaError, R>,
) => {
  const decoded = toDecoded(contract);
  return (
    input: Input<S>,
  ): Effect.Effect<A, Schema.SchemaError, R | S["DecodingServices"]> =>
    Effect.flatMap(decoded(input), write);
};
