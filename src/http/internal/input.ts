import { Effect, Schema, SchemaAST } from "effect";
import { encodedInput } from "./encoded-input.js";
import * as Excess from "./excess.js";
import { nestedEncodedInput } from "./nested-input.js";
import { snapshotter } from "./snapshot.js";
import { guardVoidMembers, observeVoid } from "./void-member.js";

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

/** Elide identical types without mistaking mutual assignability for matching nested input names. */
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// Different mutually assignable sides stay whole so their nested names and nominal identity survive.
type EitherSide<A, B> = [A, B] extends [B, A]
  ? Identical<A, B> extends true
    ? A
    : A | B
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
 *
 * A list has no fields, so it is never read field by field, at any depth: that route copies the
 * value into a new object, and a record or a struct could take the copy in the list's place. Union
 * members are still tried in turn, each by the same rules, because a member read alone can settle
 * what the whole union refuses, as an any-one union of two list members can.
 */
export const toDecoded = <S extends Schema.Top>(
  contract: S,
  options?: SchemaAST.ParseOptions,
) => {
  const make = (
    input: unknown,
    parseOptions: SchemaAST.ParseOptions | undefined,
  ) =>
    Effect.mapError(
      contract.makeEffect(input, parseOptions && { parseOptions }),
      (issue) => new Schema.SchemaError(issue),
    );
  const decode = Schema.decodeUnknownEffect(contract);
  const byField = Effect.fnUntraced(function* (
    input: object,
    parseOptions?: SchemaAST.ParseOptions,
    onFieldwise?: () => void,
  ) {
    const output: Record<PropertyKey, unknown> = { ...input };
    // A field need not be a key, as an accessor on a class is not, so it comes from `input`.
    const fields: Record<PropertyKey, unknown> = input as never;
    for (const { name, type } of Excess.fieldsOf(contract.ast))
      if (fields[name] !== undefined)
        output[name] = yield* fromPart(type, fields[name], parseOptions);
    const value = yield* make(output, parseOptions);
    onFieldwise?.();
    return value;
  });
  const byMember = (
    input: object,
    failure: Schema.SchemaError,
    parseOptions?: SchemaAST.ParseOptions,
    onFieldwise?: () => void,
  ) =>
    contract.ast._tag === "Union" && contract.ast.types.length > 0
      ? Effect.firstSuccessOf(
          contract.ast.types.map((member) =>
            fromPart(member, input, parseOptions, onFieldwise),
          ),
        )
      : // A copy of a list is an object keyed by its indexes, which a record or struct could take.
        Array.isArray(input)
        ? Effect.fail(failure)
        : byField(input, parseOptions, onFieldwise);
  return (
    input: Input<S>,
    onConstructed?: () => void,
    onFieldwise?: () => void,
    parseOptions = options,
  ): Effect.Effect<S["Type"], Schema.SchemaError, S["DecodingServices"]> =>
    Effect.matchEffect(make(input, parseOptions), {
      onSuccess: (value) => {
        // Observe only the initial whole constructor, outside its failure handler.
        onConstructed?.();
        return Effect.succeed(value);
      },
      onFailure: (failure) =>
        Effect.mapError(
          Effect.catch(decode(input, parseOptions), (encodedFailure) =>
            typeof input === "object" && input !== null
              ? byMember(input, encodedFailure, parseOptions, onFieldwise)
              : Effect.fail(encodedFailure),
          ),
          () => failure,
        ),
    }) as Effect.Effect<S["Type"], Schema.SchemaError, S["DecodingServices"]>;
};

/** Read a field or union member, which may be on either side of its own schema. */
const fromPart = (
  ast: SchemaAST.AST,
  value: unknown,
  options?: SchemaAST.ParseOptions,
  onFieldwise?: () => void,
): Effect.Effect<unknown, Schema.SchemaError, unknown> =>
  toDecoded(Schema.make<Schema.Top>(ast), options)(
    value,
    undefined,
    onFieldwise,
  );

/** What a schema wrote, and the fields of its input it would lose, which may be held elsewhere. */
export interface Written<A> {
  readonly output: A;
  readonly lost: ReadonlyArray<Excess.Path>;
}

/** Whether a lost field is the witnessed alias or one of its ancestors. */
const coversPath = (lost: Excess.Path, alias: Excess.Path): boolean =>
  lost.length <= alias.length &&
  lost.every((part, index) => part === alias[index]);

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
 * The strict pass also gives a visible object or list a chance to win over Void in an any-of union.
 */
const readerForCodec = <S extends Schema.Top, A, R>(
  contract: S,
  codec: Schema.ConstraintCodec<S["Type"], A, unknown, R>,
  guarded: ReturnType<typeof guardVoidMembers>,
  write: Write<S, A, R> = Schema.encodeEffect(codec),
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
  const ast = contract.ast;
  if (guarded.ast === ast && !Excess.choosing(ast))
    return (input: Input<S>) => written(decoded(input));
  const guardWrite =
    codec.ast === ast
      ? guarded.ast
      : guarded.ast === ast
        ? codec.ast
        : guardVoidMembers(codec.ast).ast;
  const strictWriter =
    guardWrite !== codec.ast
      ? Schema.encodeEffect(Schema.make<typeof codec>(guardWrite))
      : write;
  const preserving =
    guarded.ast === ast ? contract : Schema.make<S>(guarded.ast);
  // A suspended schema may name one defined after this binding, so resolve these on first use.
  const recovers = Excess.lazily(() => Excess.recovers(ast));
  const holdsEmptyClass = Excess.lazily(() => Excess.holdsEmptyClass(ast));
  const exact = toDecoded(preserving, Excess.strict);
  const kept = (input: Input<S>, options: SchemaAST.ParseOptions) =>
    Effect.flatMap(
      Effect.mapError(
        exact(input, undefined, undefined, options),
        (failure) => ({ failure, reading: true }),
      ),
      (value) =>
        Effect.mapError(
          Effect.map(
            strictWriter(value, Excess.strict),
            (output): Written<A> => ({
              output,
              // A strict read strips nothing it can see, but middleware can recover a value that
              // holds none of the cells of the caller's list.
              lost: recovers()
                ? Excess.lostCells([ast], input, value, output)
                : [],
            }),
          ),
          (failure) => ({
            failure,
            reading: false,
          }),
        ),
    );
  const compared = (
    input: Input<S>,
    given: unknown,
    read = decoded,
    onWriteFailure?: () => void,
    voidDeclined = false,
  ) =>
    Effect.suspend(() => {
      let constructed = false;
      return Effect.flatMap(
        read(input, () => {
          constructed = true;
        }),
        (value) =>
          Effect.map(
            Effect.catch(strictWriter(value, Excess.strict), () => {
              onWriteFailure?.();
              // Relax excess-property handling while keeping any Void guard on the writer.
              return strictWriter(value);
            }),
            (output): Written<A> => ({
              output,
              lost: Excess.missing(
                [ast],
                given,
                value,
                output,
                [],
                constructed && voidDeclined ? guarded.choices : undefined,
              ),
            }),
          ),
      );
    });
  const encoded = encodedInput(ast, guarded.isAliasAlternative);
  const nested = nestedEncodedInput(ast, guarded.isAliasAlternative);
  const decode = (encoded || nested) && Schema.decodeUnknownEffect(contract);
  const decodeWithVoidGuard =
    decode && preserving !== contract
      ? Schema.decodeUnknownEffect(preserving)
      : undefined;
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
    const candidate = yield* strictWriter(value, Excess.strict);
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
    const encodedEvidence = encoded?.(input);
    const nestedEvidence = nested?.(input);
    const captured = snapshot?.(input);
    const given = Excess.normalised([ast], input);
    // A strict read cannot see a field outside a value's keys, so it may not fall back on `input`.
    const seen = (
      given === input ? input : Excess.exposed([ast], input)
    ) as Input<S>;
    // An empty class after a list member takes a list only when that member refuses it. It then
    // reads the caller's cells as given, so they are read again with no cell key left out for it.
    const forClasses = (read: Written<A>, options: SchemaAST.ParseOptions) =>
      holdsEmptyClass() && Excess.passedClassTook([ast], given, read.output)
        ? Effect.orElseSucceed(
            kept(
              Excess.normalisedForClasses([ast], input) as Input<S>,
              options,
            ),
            () => read,
          )
        : Effect.succeed(read);
    const attempt = (options: SchemaAST.ParseOptions) =>
      given === input
        ? kept(input, options)
        : Effect.catch(
            Effect.flatMap(kept(given as Input<S>, options), (read) =>
              forClasses(read, options),
            ),
            (first) =>
              Effect.mapError(kept(seen, options), (last) => ({
                ...last,
                reading: first.reading && last.reading,
              })),
          );
    const strictRead =
      guarded.ast === ast
        ? Effect.mapError(attempt(Excess.strict), (result) => ({
            ...result,
            declined: false,
          }))
        : Effect.suspend(() => {
            // Keep each run's strict outcomes local if preparation runs again.
            let declined = false;
            const options = observeVoid(Excess.strict, () => {
              declined = true;
            });
            return Effect.mapError(attempt(options), (result) => ({
              ...result,
              declined,
            }));
          });
    const original = Effect.catch(
      strictRead,
      ({ failure, reading, declined }) => {
        if (
          !reading ||
          decode === undefined ||
          (!encodedEvidence?.matches() && nestedEvidence === undefined)
        )
          return compared(input, given, decoded, undefined, declined);
        return Effect.suspend(() => {
          let constructed = false;
          let fieldwise = false;
          let strictWrite = true;
          const read = (current: Input<S>, onConstructed?: () => void) =>
            decoded(
              current,
              () => {
                constructed = true;
                onConstructed?.();
              },
              () => {
                fieldwise = true;
              },
            );
          return Effect.flatMap(
            compared(
              input,
              given,
              read,
              () => {
                strictWrite = false;
              },
              declined,
            ),
            (constructedResult) => {
              // Keep constructor alternatives and existing failures. Only an actual encoded write
              // can hide this constructor's inability to consume the encoded-only caller field.
              if (
                (!constructed && !fieldwise) ||
                !strictWrite ||
                (!constructed && !encodedEvidence)
              )
                return Effect.succeed(constructedResult);
              const key = encodedEvidence?.matches()
                ? encodedEvidence.witness(constructedResult.output)
                : undefined;
              const rootWitness =
                key !== undefined && encodedEvidence?.matches()
                  ? { path: [key], matches: encodedEvidence.matches }
                  : undefined;
              const witness =
                rootWitness ??
                (constructed
                  ? nestedEvidence?.select(constructedResult.output)
                  : undefined);
              if (witness === undefined)
                return Effect.succeed(constructedResult);
              const refusal = declined
                ? Excess.refusal(ast, [witness.path])
                : failure;
              // This winning fieldwise route followed a failed whole decode and never read the
              // encoded-only caller name. Refuse its generated replacement without replaying effects.
              if (fieldwise && rootWitness !== undefined)
                return Effect.fail(refusal);
              // The alias proof ruled out a guarded Void as a reader of this object. Keep that
              // guard during the confirming decode so it cannot swallow the rejected alias.
              const confirm = (declined && decodeWithVoidGuard) || undefined;
              const encodedRead = (current: Input<S>) =>
                Effect.flatMap(
                  confirm === undefined
                    ? Effect.mapError(decode(current), () => refusal)
                    : Effect.catch(confirm(current), (confirmationFailure) =>
                        Effect.flatMap(
                          compared(current, given, (candidate) =>
                            Effect.mapError(decode(candidate), () => refusal),
                          ),
                          ({ lost }) =>
                            Effect.fail(
                              witness.matches() &&
                                lost.some((path) =>
                                  coversPath(path, witness.path),
                                )
                                ? refusal
                                : confirmationFailure,
                            ),
                        ),
                      ),
                  (value) =>
                    witness.matches()
                      ? Effect.succeed(value)
                      : Effect.fail(refusal),
                );
              return Effect.flatMap(
                compared(input, given, encodedRead),
                (result) =>
                  witness.matches()
                    ? Effect.succeed(result)
                    : Effect.fail(refusal),
              );
            },
          );
        });
      },
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

export const reader = <S extends Schema.Top>(
  contract: S,
  write?: Write<S, S["Encoded"], S["EncodingServices"]>,
) =>
  readerForCodec<S, S["Encoded"], S["EncodingServices"]>(
    contract,
    contract,
    guardVoidMembers(contract.ast),
    write,
  );

/**
 * Whole-union alternatives for an anyOf group without group encoding. Preserve every member and
 * the whole input: trying one member alone would move its decoder ahead of another's constructor.
 * Keep parent validation, context and annotations unchanged on every attempt.
 */
export const reorderedReaders = <S extends Schema.Top>(contract: S) => {
  const ast = contract.ast;
  if (
    ast._tag !== "Union" ||
    (ast.options?.mode ?? "anyOf") !== "anyOf" ||
    ast.encoding !== undefined ||
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
        ast.checks,
        undefined,
        ast.context,
        ast.encodingChecks,
      ),
    );
    return reader(reordered);
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
  codec: Schema.ConstraintCodec<S["Type"], A, unknown, R>,
) => {
  const guarded = guardVoidMembers(contract.ast);
  if (guarded.ast === contract.ast && !Excess.choosing(contract.ast))
    return stripping(contract, Schema.encodeEffect(codec));
  const read = readerForCodec(contract, codec, guarded);
  return (
    input: Input<S>,
  ): Effect.Effect<A, Schema.SchemaError, R | S["DecodingServices"]> =>
    Effect.flatMap(read(input), ({ output, lost }) =>
      Effect.as(refuseLost(contract, lost), output),
    );
};
