import { Effect, Schema, SchemaAST, SchemaIssue } from "effect";
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
 * A decoded value, and what reading it field by field shows that the value cannot.
 *
 * @remarks
 * A fieldwise read builds its value with the schema's constructor over what each part read. That
 * constructor runs again over a part's result, so it fills a default where the part lost the
 * caller's field, and the value then looks as if the field was kept.
 */
interface Decoded<A> {
  readonly value: A;
  /** The value with each part's own result in place, or `value` itself where no part was read. */
  readonly view: unknown;
  /** Fields, from this value, that a part's own constructor was given and did not keep. */
  readonly lost: ReadonlyArray<Excess.Path>;
}

const whole = <A>(value: A): Decoded<A> => ({ value, view: value, lost: [] });

/** A value with each part's result in front of its own properties, which stay underneath. */
const withParts = (
  value: unknown,
  parts: ReadonlyArray<readonly [PropertyKey, unknown]>,
): unknown => {
  if (parts.length === 0 || typeof value !== "object" || value === null)
    return value;
  const view = Object.create(value) as object;
  for (const [name, part] of parts)
    Object.defineProperty(view, name, { value: part, enumerable: true });
  return view;
};

/**
 * Bring a value to its decoded side, as {@link toDecoded} does, and keep the evidence of what its
 * parts lost. A part is a field read on its own: `part` makes its constructor prove that it kept
 * every field it was given, or give way to the routes after it.
 */
const decodedReading = <S extends Schema.Top>(
  contract: S,
  options?: SchemaAST.ParseOptions,
  part = false,
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
  /**
   * The fields a constructor was given and did not keep, leaving out those read as parts. It reads
   * the decoded side and strips the rest, such as an encoded name, so what it made has to hold
   * every field it took as given. A parent's constructor runs over the result and cannot tell.
   */
  const unkept = (
    input: unknown,
    value: unknown,
    read: ReadonlySet<PropertyKey> = new Set(),
  ) => {
    const given = Excess.normalised([contract.ast], input);
    if (read.size === 0 || typeof given !== "object" || given === null)
      return Excess.missing([contract.ast], given, value, undefined);
    const fields: Record<PropertyKey, unknown> = given as never;
    const taken = Object.fromEntries(
      Reflect.ownKeys(given)
        .filter(
          (name) =>
            !read.has(name) &&
            Object.prototype.propertyIsEnumerable.call(given, name),
        )
        .map((name) => [name, fields[name]]),
    );
    return Excess.missing([contract.ast], taken, value, undefined);
  };
  const byField = Effect.fnUntraced(function* (
    input: object,
    parseOptions?: SchemaAST.ParseOptions,
    onFieldwise?: () => void,
  ) {
    const output: Record<PropertyKey, unknown> = { ...input };
    // A field need not be a key, as an accessor on a class is not, so it comes from `input`.
    const fields: Record<PropertyKey, unknown> = input as never;
    const parts: Array<readonly [PropertyKey, unknown]> = [];
    const lost: Array<Excess.Path> = [];
    for (const { name, type } of Excess.fieldsOf(contract.ast)) {
      if (fields[name] === undefined) continue;
      const read = yield* fromPart(type, fields[name], parseOptions, true);
      output[name] = read.value;
      parts.push([name, read.view]);
      for (const path of read.lost) lost.push([name, ...path]);
    }
    const value = yield* make(output, parseOptions);
    onFieldwise?.();
    // The root's encoded-only names have their own proof; a part's are checked here.
    if (part)
      lost.push(...unkept(input, value, new Set(parts.map(([name]) => name))));
    return { value, view: withParts(value, parts), lost };
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
            fromPart(member, input, parseOptions, part, onFieldwise),
          ),
        )
      : // A copy of a list is an object keyed by its indexes, which a record or struct could take.
        Array.isArray(input)
        ? Effect.fail(failure)
        : byField(input, parseOptions, onFieldwise);
  const afterConstruction = (
    input: unknown,
    parseOptions?: SchemaAST.ParseOptions,
    onFieldwise?: () => void,
  ): Effect.Effect<Decoded<unknown>, Schema.SchemaError, unknown> =>
    Effect.catch(
      Effect.map(decode(input, parseOptions), whole),
      (encodedFailure) =>
        typeof input === "object" && input !== null
          ? byMember(input, encodedFailure, parseOptions, onFieldwise)
          : Effect.fail(encodedFailure),
    );
  return (
    input: Input<S>,
    onConstructed?: () => void,
    onFieldwise?: () => void,
    parseOptions = options,
  ): Effect.Effect<
    Decoded<S["Type"]>,
    Schema.SchemaError,
    S["DecodingServices"]
  > =>
    Effect.matchEffect(make(input, parseOptions), {
      onSuccess: (value) => {
        // Observe only the initial whole constructor, outside its failure handler.
        onConstructed?.();
        if (!part) return Effect.succeed(whole(value));
        const lost = unkept(input, value);
        return lost.length === 0
          ? Effect.succeed(whole(value))
          : Effect.catch(
              afterConstruction(input, parseOptions, onFieldwise),
              () => Effect.succeed({ value, view: value, lost }),
            );
      },
      onFailure: (failure) =>
        Effect.mapError(
          afterConstruction(input, parseOptions, onFieldwise),
          () => failure,
        ),
    }) as Effect.Effect<
      Decoded<S["Type"]>,
      Schema.SchemaError,
      S["DecodingServices"]
    >;
};

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
 *
 * Read field by field, a part whose constructor loses a field it was given takes the next route,
 * and keeps that loss if none fits. {@link decodedReading} keeps the evidence for the caller.
 */
export const toDecoded = <S extends Schema.Top>(
  contract: S,
  options?: SchemaAST.ParseOptions,
) => {
  const read = decodedReading(contract, options);
  return (
    input: Input<S>,
    onConstructed?: () => void,
    onFieldwise?: () => void,
    parseOptions = options,
  ): Effect.Effect<S["Type"], Schema.SchemaError, S["DecodingServices"]> =>
    Effect.map(
      read(input, onConstructed, onFieldwise, parseOptions),
      ({ value }) => value,
    );
};

/**
 * Read a field or union member, which may be on either side of its own schema. A member reads its
 * union's input, so it is a part only where its union is.
 */
const fromPart = (
  ast: SchemaAST.AST,
  value: unknown,
  options: SchemaAST.ParseOptions | undefined,
  part: boolean,
  onFieldwise?: () => void,
): Effect.Effect<Decoded<unknown>, Schema.SchemaError, unknown> =>
  decodedReading(Schema.make<Schema.Top>(ast), options, part)(
    value,
    undefined,
    onFieldwise,
  );

/** What a schema wrote, and the fields of its input it would lose, which may be held elsewhere. */
export interface Written<A> {
  readonly output: A;
  readonly lost: ReadonlyArray<Excess.Path>;
  /**
   * The fields in `lost` that only the write lost, after the first member that could not write the
   * value gave way to one that strips them, and that member's failure.
   */
  readonly unwritten?: {
    readonly lost: ReadonlyArray<Excess.Path>;
    readonly failure: Schema.SchemaError;
  };
}

/** Whether a lost field is the witnessed alias or one of its ancestors. */
const coversPath = (lost: Excess.Path, alias: Excess.Path): boolean =>
  lost.length <= alias.length &&
  lost.every((part, index) => part === alias[index]);

const samePath = (path: Excess.Path, other: Excess.Path): boolean =>
  path.length === other.length &&
  path.every((part, index) => part === other[index]);

const distinctPaths = (
  ...lists: ReadonlyArray<ReadonlyArray<Excess.Path>>
): ReadonlyArray<Excess.Path> =>
  lists
    .flat()
    .filter(
      (path, index, all) =>
        all.findIndex((other) => samePath(other, path)) === index,
    );

/** Whether a member's failure only names keys it does not state, which a relaxed write strips. */
const strips = (issue: SchemaIssue.Issue): boolean => {
  switch (issue._tag) {
    case "UnexpectedKey":
      return true;
    case "Pointer":
    case "Encoding":
    case "Filter":
      return strips(issue.issue);
    case "Composite":
      return issue.issues.every(strips);
    case "AnyOf":
      return issue.issues.some(strips);
    default:
      return false;
  }
};

/** A guarded Void declines an object or list. That says nothing about the value it was given. */
const declinedByVoid = (issue: SchemaIssue.Issue): boolean =>
  issue._tag === "InvalidType" && issue.ast._tag === "Void";

/**
 * A strict write's failure as the first member that could not write the value reports it, at each
 * union, without the members a relaxed write could take by stripping keys. Undefined if every
 * member only strips or declines.
 */
const unwritable = (
  issue: SchemaIssue.Issue,
): SchemaIssue.Issue | undefined => {
  switch (issue._tag) {
    case "UnexpectedKey":
      return undefined;
    case "Pointer": {
      const inner = unwritable(issue.issue);
      return inner && new SchemaIssue.Pointer(issue.path, inner);
    }
    case "Encoding": {
      const inner = unwritable(issue.issue);
      return inner && new SchemaIssue.Encoding(issue.ast, inner);
    }
    case "Filter": {
      const inner = unwritable(issue.issue);
      return inner && new SchemaIssue.Filter(issue.filter, inner);
    }
    case "Composite": {
      const [first, ...others] = issue.issues.flatMap(
        (inner) => unwritable(inner) ?? [],
      );
      return first && new SchemaIssue.Composite(issue.ast, [first, ...others]);
    }
    case "AnyOf": {
      const member = issue.issues.find(
        (inner) => !strips(inner) && !declinedByVoid(inner),
      );
      return member && unwritable(member);
    }
    default:
      return issue;
  }
};

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
              lost: [],
            }),
          ),
          (failure) => ({
            failure,
            reading: false,
          }),
        ),
    );
  const readDecoded = decodedReading(contract);
  // The JSON codec and the contract both decode with the contract's services.
  const sentBack = Schema.decodeUnknownEffect(
    Schema.make<Schema.Decoder<S["Type"], S["DecodingServices"]>>(guardWrite),
  );
  /**
   * The fields a relaxed write lost. It can take a later member, which strips a field the decoded
   * value still holds, so Effect reads back what it sent. A field sent under its own name needs no
   * reading, and one that cannot be read back cannot show that it went.
   */
  const unsent = (
    given: unknown,
    output: A,
    choices: WeakSet<SchemaAST.AST> | undefined,
  ) => {
    const absent = Excess.missing([ast], given, undefined, output, [], choices);
    return absent.length === 0
      ? Effect.succeed(absent)
      : Effect.match(sentBack(output), {
          onFailure: () => absent,
          onSuccess: (sent) =>
            Excess.missing([ast], given, sent, output, [], choices),
        });
  };
  const compared = (
    input: Input<S>,
    given: unknown,
    read: (
      input: Input<S>,
      onConstructed?: () => void,
    ) => Effect.Effect<
      Decoded<S["Type"]>,
      Schema.SchemaError,
      S["DecodingServices"]
    > = readDecoded,
    onWriteFailure?: () => void,
    voidDeclined = false,
  ) =>
    Effect.suspend(() => {
      let constructed = false;
      return Effect.flatMap(
        read(input, () => {
          constructed = true;
        }),
        ({ value, view, lost: lostByParts }) =>
          Effect.flatMap(
            Effect.catch(
              Effect.map(
                strictWriter(value, Excess.strict),
                (output): { output: A; strict?: Schema.SchemaError } => ({
                  output,
                }),
              ),
              (strict) => {
                onWriteFailure?.();
                // Relax excess-property handling while keeping any Void guard on the writer.
                return Effect.map(strictWriter(value), (output) => ({
                  output,
                  strict,
                }));
              },
            ),
            ({ output, strict }) => {
              const choices =
                constructed && voidDeclined ? guarded.choices : undefined;
              const lost = distinctPaths(
                Excess.missing([ast], given, value, output, [], choices),
                // A part's result shows the field a constructor default took the place of.
                view === value
                  ? []
                  : Excess.missing([ast], given, view, output, [], choices),
                lostByParts,
              );
              if (strict === undefined)
                return Effect.succeed<Written<A>>({ output, lost });
              return Effect.map(
                unsent(given, output, choices),
                (dropped): Written<A> => {
                  const extra = dropped.filter(
                    (path) => !lost.some((known) => samePath(known, path)),
                  );
                  const failure =
                    extra.length === 0 ? undefined : unwritable(strict.issue);
                  return {
                    output,
                    lost: [...lost, ...extra],
                    ...(failure !== undefined && {
                      unwritten: {
                        lost: extra,
                        failure: new Schema.SchemaError(failure),
                      },
                    }),
                  };
                },
              );
            },
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
    const attempt = (options: SchemaAST.ParseOptions) =>
      given === input
        ? kept(input, options)
        : Effect.catch(kept(given as Input<S>, options), (first) =>
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
          return compared(input, given, readDecoded, undefined, declined);
        return Effect.suspend(() => {
          let constructed = false;
          let fieldwise = false;
          let strictWrite = true;
          const read = (current: Input<S>, onConstructed?: () => void) =>
            readDecoded(
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
                            Effect.map(
                              Effect.mapError(decode(candidate), () => refusal),
                              whole,
                            ),
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
                compared(input, given, (current) =>
                  Effect.map(encodedRead(current), whole),
                ),
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
 *
 * Where only the write lost them, the refusal is the failure of the member that could not write
 * them, as that member alone would refuse.
 */
export const refuseLost = (
  contract: Schema.Top,
  lost: ReadonlyArray<Excess.Path>,
  taken?: ReadonlySet<PropertyKey>,
  unwritten?: Written<unknown>["unwritten"],
): Effect.Effect<void, Schema.SchemaError> => {
  const [first, ...others] = lost.filter(
    (path) => path.length > 1 || taken?.has(path[0]!) !== true,
  );
  if (first === undefined) return Effect.void;
  return Effect.fail(
    unwritten !== undefined &&
      [first, ...others].every((path) =>
        unwritten.lost.some((other) => samePath(other, path)),
      )
      ? unwritten.failure
      : Excess.refusal(contract.ast, [first, ...others]),
  );
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
    Effect.flatMap(read(input), ({ output, lost, unwritten }) =>
      Effect.as(refuseLost(contract, lost, undefined, unwritten), output),
    );
};
