import { Effect, Schema, SchemaAST } from "effect";
import * as Excess from "./excess.js";
import { snapshotter } from "./snapshot.js";

/** What a schema's constructor takes. This is the one place that names the `~`-prefixed key. */
type ConstructorInput<S extends Schema.Top> = S["~type.make.in"];

/** A field's type on the encoded side, in whichever union members have it. */
type EncodedField<B, K> = B extends unknown
  ? K extends keyof B
    ? B[K]
    : never
  : never;

/**
 * Either side of a schema, chosen field by field. A list is a value, so it has no fields, and an
 * object whose encoded side is not one, such as a `Date` from text, has none to choose from.
 */
type Fieldwise<A, B> =
  A extends ReadonlyArray<unknown>
    ? never
    : A extends object
      ? B extends object
        ? { readonly [K in keyof A]: A[K] | EncodedField<B, K> }
        : never
      : never;

/** Every key of every member. `keyof` on a union keeps only the keys all its members share. */
type KeysOf<T> = T extends unknown ? keyof T : never;

/**
 * Leave out the sides when the mix takes everything they do, which an editor would show three times.
 *
 * @remarks
 * Assignability is not enough on its own, because a stray key in a literal is an error against the
 * mix even when the value is assignable to it. A renamed field needs its side for that reason, and
 * a field the mix requires and one side leaves out needs its side too.
 */
type Merged<Sides, Mix> = [Sides] extends [Mix]
  ? [KeysOf<Sides>] extends [KeysOf<Mix>]
    ? Mix
    : Sides | Mix
  : Sides | Mix;

type EitherSide<A, B> = [A, B] extends [B, A]
  ? A
  : Merged<A | B, Fieldwise<A, B>>;

/** What a schema-backed input takes: its decoded side, its encoded side, or a mix by field. */
export type Input<S extends Schema.Top> = EitherSide<
  ConstructorInput<S>,
  S["Encoded"]
>;

/**
 * Bring a value on either side of a schema to its decoded side.
 *
 * @remarks
 * A value that fits the decoded side is read as decoded, so it is encoded once. Anything else goes
 * through the decoder as a whole, then field by field. Both routes validate, and a value that fits
 * neither fails with the decoded side's error, so existing failures read the same. `options` go to
 * every parse.
 */
export const toDecoded = <S extends Schema.Top>(
  contract: S,
  options?: SchemaAST.ParseOptions,
) => {
  const making = options && { parseOptions: options };
  const make = (input: unknown) =>
    Effect.mapError(
      contract.makeEffect(input, making),
      (issue) => new Schema.SchemaError(issue),
    );
  const decode = Schema.decodeUnknownEffect(contract);
  const byField = Effect.fnUntraced(function* (input: object) {
    const output: Record<PropertyKey, unknown> = { ...input };
    // A field need not be a key, as an accessor on a class is not, so it comes from `input`.
    const fields: Record<PropertyKey, unknown> = input as never;
    for (const { name, type } of Excess.fieldsOf(contract.ast))
      if (fields[name] !== undefined)
        output[name] = yield* fromPart(type, fields[name], options);
    return yield* make(output);
  });
  const byMember = (input: object) =>
    contract.ast._tag === "Union" && contract.ast.types.length > 0
      ? Effect.firstSuccessOf(
          contract.ast.types.map((member) => fromPart(member, input, options)),
        )
      : byField(input);
  return (
    input: Input<S>,
  ): Effect.Effect<S["Type"], Schema.SchemaError, S["DecodingServices"]> =>
    Effect.catch(make(input), (failure) =>
      Effect.mapError(
        Effect.catch(decode(input, options), (encodedFailure) =>
          typeof input === "object" && input !== null
            ? byMember(input)
            : Effect.fail(encodedFailure),
        ),
        () => failure,
      ),
    ) as Effect.Effect<S["Type"], Schema.SchemaError, S["DecodingServices"]>;
};

/** Read a field or union member, which may be on either side of its own schema. */
const fromPart = (
  ast: SchemaAST.AST,
  value: unknown,
  options?: SchemaAST.ParseOptions,
): Effect.Effect<unknown, Schema.SchemaError, unknown> =>
  toDecoded(Schema.make<Schema.Top>(ast), options)(value);

/** What a schema wrote, and the fields of its input it would lose, which may be held elsewhere. */
export interface Written<A> {
  readonly output: A;
  readonly lost: ReadonlyArray<Excess.Path>;
}

/** Takes a decoded value out through a schema, as the options say. */
type Write<S extends Schema.Top, A, R> = (
  value: S["Type"],
  options?: SchemaAST.ParseOptions,
) => Effect.Effect<A, Schema.SchemaError, R>;

/** Bring a value to the schema's decoded side, then write it, as Effect reads it. */
const stripping = <S extends Schema.Top, A, R>(
  contract: S,
  write: Write<S, A, R>,
) => {
  const decoded = toDecoded(contract);
  return (
    input: Input<S>,
  ): Effect.Effect<A, Schema.SchemaError, R | S["DecodingServices"]> =>
    Effect.flatMap(decoded(input), write);
};

/**
 * Bring a value to the schema's decoded side, then write it, and say what that would lose.
 *
 * @remarks
 * Effect takes the first union member that fits and strips what that member does not state, on the
 * decoded side and again when it encodes, so a later member that holds everything would lose to an
 * earlier one that holds part of it. A value on a schema's encoded side can lose to its decoded side
 * in the same way, where the two state different names. So a schema with either choice reads what
 * the caller means strictly, through both steps, and a read that passes has stripped nothing.
 *
 * A value that cannot be read that way is read as Effect reads it, and the result is compared with
 * what went in, so what is lost is what actually went, not what a failure suggests would. The write
 * is strict first, because a loose write can choose another member and lose what the read kept.
 *
 * A schema with neither choice skips the strict read and loss comparison.
 */
export const reader = <S extends Schema.Top, A, R>(
  contract: S,
  write: Write<S, A, R>,
) => {
  const decoded = toDecoded(contract);
  const written = (
    reading: ReturnType<typeof decoded>,
    options?: SchemaAST.ParseOptions,
  ) =>
    Effect.flatMap(reading, (value) =>
      Effect.map(write(value, options), (output): Written<A> => ({
        output,
        lost: [],
      })),
    );
  if (!Excess.choosing(contract.ast))
    return (input: Input<S>) => written(decoded(input));
  const exact = toDecoded(contract, Excess.strict);
  const kept = (input: Input<S>) => written(exact(input), Excess.strict);
  const compared = (input: Input<S>, given: unknown) =>
    Effect.flatMap(decoded(input), (value) =>
      Effect.map(
        Effect.catch(write(value, Excess.strict), () => write(value)),
        (output): Written<A> => ({
          output,
          lost: Excess.missing([contract.ast], given, value, output),
        }),
      ),
    );
  const ast = contract.ast;
  const recoverable =
    ast._tag === "Objects" &&
    ast.encoding === undefined &&
    ast.indexSignatures.length === 0 &&
    !ast.propertySignatures.some(({ name }) => name === Symbol.iterator) &&
    ast.propertySignatures.some(
      ({ type }) => type._tag === "Declaration" && type.encoding === undefined,
    );
  const snapshot = recoverable ? snapshotter([ast]) : undefined;
  const recover = Effect.fnUntraced(function* (
    input: unknown,
    original: Written<A>,
  ) {
    if (ast._tag !== "Objects") return original;
    // Candidate callbacks receive the captured input too; keep their evidence independent of it.
    const evidence = snapshot?.(input);
    if (evidence === undefined) return original;
    const given = Excess.normalised([ast], evidence.value);
    const prototype: unknown = Object.getPrototypeOf(input);
    const output = Object.create(prototype as object | null) as Record<
      PropertyKey,
      unknown
    >;
    for (const name of Reflect.ownKeys(input as object)) {
      const property = Object.getOwnPropertyDescriptor(input, name)!;
      Object.defineProperty(output, name, {
        value: property.value,
        enumerable: property.enumerable === true,
        writable: true,
        configurable: true,
      });
    }
    for (const { name, type } of ast.propertySignatures) {
      const value = output[name];
      if (value === undefined) continue;
      const field = Schema.make<Schema.Top>(type);
      const made = yield* Effect.mapError(
        field.makeEffect(
          value,
          type._tag === "Declaration" && type.encoding === undefined
            ? undefined
            : { parseOptions: Excess.strict },
        ),
        (issue) => new Schema.SchemaError(issue),
      );
      Object.defineProperty(output, name, {
        value: made,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    const value = yield* Effect.mapError(
      contract.makeEffect(output, { parseOptions: Excess.strict }),
      (issue) => new Schema.SchemaError(issue),
    );
    const candidate = yield* write(value, Excess.strict);
    const lost = Excess.missing([ast], given, value, candidate);
    return lost.length === 0 ? { output: candidate, lost } : original;
  });
  return (
    input: Input<S>,
  ): Effect.Effect<
    Written<A>,
    Schema.SchemaError,
    R | S["DecodingServices"]
  > => {
    const captured = snapshot?.(input);
    const given = Excess.normalised([contract.ast], input);
    // A strict read cannot see a field outside a value's keys, so it may not fall back on `input`.
    const seen = (
      given === input ? input : Excess.exposed([contract.ast], input)
    ) as Input<S>;
    const original = Effect.catch(
      given === input
        ? kept(input)
        : Effect.catch(kept(given as Input<S>), () => kept(seen)),
      () => compared(input, given),
    );
    if (captured === undefined) return original;
    return Effect.flatMap(original, (result) =>
      result.lost.some((path) => path.length > 1) && captured.matches(input)
        ? Effect.catch(recover(captured.value, result), () =>
            Effect.succeed(result),
          )
        : Effect.succeed(result),
    );
  };
};

/**
 * Whole-union alternatives for an anyOf group without parent behavior. Preserve every member and
 * the whole input: trying one member alone would move its decoder ahead of another's constructor.
 * Keep annotations unchanged; parent checks, encoding and context remain excluded.
 */
export const reorderedReaders = <S extends Schema.Top>(contract: S) => {
  const ast = contract.ast;
  if (
    ast._tag !== "Union" ||
    (ast.options?.mode ?? "anyOf") !== "anyOf" ||
    ast.encoding !== undefined ||
    ast.context !== undefined ||
    ast.checks !== undefined ||
    ast.encodingChecks !== undefined ||
    !ast.types.every(
      (member) =>
        member._tag === "Objects" &&
        member.encoding === undefined &&
        member.indexSignatures.length === 0 &&
        !member.propertySignatures.some(({ name }) => name === Symbol.iterator),
    )
  )
    return [];
  // The unchanged order already supplied `original`; repeating it adds no selection alternative.
  return ast.types.slice(1).map((member, offset) => {
    const index = offset + 1;
    const reordered = Schema.make<S>(
      new SchemaAST.Union(
        [member, ...ast.types.filter((_, position) => position !== index)],
        ast.options,
        ast.annotations,
      ),
    );
    return reader(reordered, Schema.encodeEffect(reordered));
  });
};

/**
 * Refuse the fields a schema would lose, unless another schema in the group took them. Only a field
 * of the group itself can be taken, so one further down a value stays lost.
 */
export const refuseLost = (
  contract: Schema.Top,
  lost: ReadonlyArray<Excess.Path>,
  taken?: ReadonlySet<PropertyKey>,
): Effect.Effect<void, Schema.SchemaError> => {
  const [first, ...others] = lost.filter(
    (path) => path.length > 1 || taken?.has(path[0]!) !== true,
  );
  return first === undefined
    ? Effect.void
    : Effect.fail(Excess.refusal(contract.ast, [first, ...others]));
};

/** Bring a value to the schema's decoded side and write it, with nothing else to hold what it loses. */
export const encoder = <S extends Schema.Top, A, R>(
  contract: S,
  write: Write<S, A, R>,
) => {
  if (!Excess.choosing(contract.ast)) return stripping(contract, write);
  const read = reader(contract, write);
  return (
    input: Input<S>,
  ): Effect.Effect<A, Schema.SchemaError, R | S["DecodingServices"]> =>
    Effect.flatMap(read(input), ({ output, lost }) =>
      Effect.as(refuseLost(contract, lost), output),
    );
};
