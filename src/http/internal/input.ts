import { Effect, Schema, SchemaAST } from "effect";
import * as Excess from "./excess.js";

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

/** How one pass reads a value. */
interface Pass {
  /** What each parse takes. */
  readonly options?: SchemaAST.ParseOptions;
  /** Whether to go on field by field or member by member after the value as a whole. */
  readonly pieces: boolean;
  /** What to report once a later route has failed as well. */
  readonly either: (
    first: Schema.SchemaError,
    next: Schema.SchemaError,
  ) => Schema.SchemaError;
}

/** Effect's own reading, which strips. Reporting the first route keeps existing failures as they read. */
const stripping: Pass = { pieces: true, either: (first) => first };

/** A whole value with nothing stripped, which stops at the first key it would have to strip. */
const keeping: Pass = {
  options: Excess.strict,
  pieces: false,
  either: (first) => first,
};

/**
 * The same, reporting every key on both sides, which is how to tell what no member states. It reads
 * the value whole so that a tag can rule members out, as a read in pieces does not.
 */
const surveying: Pass = {
  options: Excess.complete,
  pieces: false,
  either: Excess.either,
};

/** The last strict reading, which also takes a mix by field. Reading in pieces is the slow part. */
const reporting: Pass = {
  options: Excess.complete,
  pieces: true,
  either: Excess.either,
};

/**
 * Bring a value on either side of a schema to its decoded side.
 *
 * @remarks
 * A value that fits the decoded side is read as decoded, so it is encoded once. Anything else goes
 * through the decoder as a whole, then field by field. Both routes validate, and a value that fits
 * neither fails with the decoded side's error, so existing failures read the same.
 */
export const toDecoded = <S extends Schema.Top>(
  contract: S,
  pass: Pass = stripping,
) => {
  const make = (input: unknown) =>
    Effect.mapError(
      contract.makeEffect(input, { parseOptions: pass.options }),
      (issue) => new Schema.SchemaError(issue),
    );
  const decode = Schema.decodeUnknownEffect(contract);
  const byField = Effect.fnUntraced(function* (input: object) {
    const output: Record<PropertyKey, unknown> = { ...input };
    for (const { name, type } of fieldsOf(contract.ast))
      if (output[name] !== undefined)
        output[name] = yield* Effect.mapError(
          fromPart(type, output[name], pass),
          (failure) => Excess.atField(name, failure),
        );
    return yield* make(output);
  });
  const byMember = (
    types: ReadonlyArray<SchemaAST.AST>,
    input: object,
  ): Effect.Effect<unknown, Schema.SchemaError, unknown> =>
    Effect.mapError(
      types.reduce<
        Effect.Effect<unknown, ReadonlyArray<Schema.SchemaError>, unknown>
      >(
        (tried, member) =>
          Effect.catch(tried, (failures) =>
            Effect.mapError(fromPart(member, input, pass), (failure) => [
              ...failures,
              failure,
            ]),
          ),
        Effect.fail([]),
      ),
      (failures) => Excess.either(...failures),
    );
  const inPieces = (input: object) =>
    contract.ast._tag === "Union"
      ? byMember(contract.ast.types, input)
      : byField(input);
  return (
    input: Input<S>,
  ): Effect.Effect<S["Type"], Schema.SchemaError, S["DecodingServices"]> =>
    Effect.catch(make(input), (failure) =>
      Effect.mapError(
        Effect.catch(decode(input, pass.options), (encodedFailure) =>
          pass.pieces && typeof input === "object" && input !== null
            ? Effect.mapError(inPieces(input), (next) =>
                pass.either(encodedFailure, next),
              )
            : Effect.fail(encodedFailure),
        ),
        (next) => pass.either(failure, next),
      ),
    ) as Effect.Effect<S["Type"], Schema.SchemaError, S["DecodingServices"]>;
};

/** Read a field or union member, which may be on either side of its own schema. */
const fromPart = (
  ast: SchemaAST.AST,
  value: unknown,
  pass: Pass,
): Effect.Effect<unknown, Schema.SchemaError, unknown> =>
  toDecoded(Schema.make<Schema.Top>(ast), pass)(value);

/**
 * Bring a value to the schema's decoded side, then write it.
 *
 * @remarks
 * Effect takes the first union member that fits and strips what that member does not state, on the
 * decoded side and again when it encodes, so a later member that holds everything would lose to an
 * earlier one that holds part of it. A schema with such a choice is therefore read strictly first,
 * through both steps, so the member that strips nothing wins.
 *
 * A strict read also fails on what no member states, which is what a stacked schema's fields look
 * like, so those keys go and it reads again. They are stripped as a struct strips them. What is left
 * is either a value no member fits, which keeps its usual failure, or a field a member states and
 * the member that fits would lose, which {@link Excess.refusal} names.
 *
 * A schema with no such choice skips all of this, so a plain struct costs what it always did.
 */
export const encoder = <S extends Schema.Top, A, R>(
  contract: S,
  write: (
    value: S["Type"],
    options?: SchemaAST.ParseOptions,
  ) => Effect.Effect<A, Schema.SchemaError, R>,
) => {
  const through = (pass: Pass) => {
    const decoded = toDecoded(contract, pass);
    return (
      input: Input<S>,
    ): Effect.Effect<A, Schema.SchemaError, R | S["DecodingServices"]> =>
      Effect.flatMap(decoded(input), (value) => write(value, pass.options));
  };
  const stripped = through(stripping);
  if (!Excess.holdsChoice(contract.ast)) return stripped;
  const kept = through(keeping);
  const surveyed = through(surveying);
  const reported = through(reporting);
  const withoutExcess = (input: Input<S>) =>
    Effect.catch(surveyed(input), ({ issue }) =>
      reported(
        Excess.excess(issue).reduce<unknown>(Excess.without, input) as Input<S>,
      ),
    );
  return (
    input: Input<S>,
  ): Effect.Effect<A, Schema.SchemaError, R | S["DecodingServices"]> =>
    Effect.catch(kept(input), () =>
      Effect.catch(withoutExcess(input), (failure) =>
        Effect.flatMap(stripped(input), (output) => {
          const [first, ...others] = Excess.lost(failure.issue, input);
          return first === undefined
            ? Effect.succeed(output)
            : Effect.fail(Excess.refusal(contract.ast, [first, ...others]));
        }),
      ),
    );
};
