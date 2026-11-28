import {
  Array as Arr,
  Effect,
  type Option,
  Result,
  Schema,
  SchemaAST,
  SchemaIssue,
} from "effect";
import {
  afterAlternative,
  attemptRead,
  FieldlessOneOf,
  hasPlainWitness,
  matchRead,
  mayHoldFieldless,
  OptionWrapperRead,
  publicAmbiguity,
  publicRead,
  readFailure,
  type ReadFailure,
  recoverRead,
} from "./ambiguity.js";
import * as Excess from "./excess.js";
import {
  isPlainData,
  statesPrototypeName,
  statesPrototypeNameAnywhere,
} from "./plain.js";
import {
  guardReading,
  guardVoids,
  notesWrapper,
  recordingWrapperInto,
} from "./void-member.js";
import { isBodyWriteError, isWriterError } from "./writer-error.js";
import {
  declinedByVoid,
  type Dropped,
  dropped as droppedBy,
  isKeyed,
  recordingInto,
  recordingWriter,
  type WriterNotes,
} from "./writers.js";

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

/** A decoded value, and the fields its reading was given and did not keep, from this value. */
interface Decoded<A> {
  readonly value: A;
  readonly lost: ReadonlyArray<Excess.Path>;
  /** The refusal to report if the enclosing alternative cannot write the fields it read. */
  readonly ambiguity?: FieldlessOneOf | undefined;
  /** Where a constructor lost fields, and what kept the decoder from reading them instead. */
  readonly refused?: ReadonlyArray<Refused> | undefined;
  /** Why fields in `lost` were lost, where more is known than the loss. */
  readonly causes?: ReadonlyArray<Excess.Cause> | undefined;
  /** Whether the decoder lost the fields in `lost`, reading the whole value on its encoded side. */
  readonly byDecoder?: true | undefined;
  /** What Effect reads in its place, for a write that can only be relaxed. */
  readonly forRelaxedWrite?: Effect.Effect<Decoded<A>, ReadFailure, unknown>;
}

/** The objects and lists holding the fields a decoder named as it failed at a place. */
interface Refused {
  readonly at: Excess.Path;
  readonly holders: ReadonlyArray<Excess.Path>;
}

const whole = <A>(value: A): Decoded<A> => ({ value, lost: [] });

/** Parse options for a strict read that reports every issue with the object it was found in. */
const reporting: SchemaAST.ParseOptions = {
  onExcessProperty: "error",
  errors: "all",
  reportInput: true,
};

/**
 * The failures of {@link reporting} reads, which decide which route a value takes but never say why
 * it is refused. Effect gives those options to every step it runs, and a step can fail differently
 * under them than under the caller's, so no refusal takes a cause from them.
 */
const readStrictly = new WeakSet<Schema.SchemaError>();

/** {@link isPlainData}, asked once of each object in one traversal, as it reads every key. */
const plainness = () => {
  const known = new Map<object, boolean>();
  return (value: object): boolean => {
    let plain = known.get(value);
    if (plain === undefined) known.set(value, (plain = isPlainData(value)));
    return plain;
  };
};

/**
 * The caller's keys a loose read would strip, from a {@link reporting} read's failure, or undefined
 * where a loose read fails too.
 *
 * @remarks
 * A strict and a loose read part only on excess keys. A key counts as the caller's when the object
 * it was found in is the caller's own object at that place, as the normalised input holds it, and
 * what the caller gave there is plain data, so that input holds only the caller's own fields. A
 * decoder or transformation makes a new object, so a key it adds is not the caller's. A union takes
 * its first member that only strips, as a loose read would.
 */
const strippedFrom = (
  issue: SchemaIssue.Issue,
  given: unknown,
  caller: unknown,
  path: Excess.Path = [],
  owned = false,
  isPlain = plainness(),
): ReadonlyArray<Excess.Path> | undefined => {
  switch (issue._tag) {
    case "UnexpectedKey":
      return [];
    case "Pointer": {
      const at = [...path, ...issue.path];
      if (issue.issue._tag === "UnexpectedKey") return owned ? [at] : [];
      const below = (from: unknown) =>
        owned
          ? issue.path.reduce<unknown>(
              (value, key) =>
                isKeyed(value) && isPlain(value) ? value[key] : undefined,
              from,
            )
          : undefined;
      return strippedFrom(
        issue.issue,
        below(given),
        below(caller),
        at,
        false,
        isPlain,
      );
    }
    case "Composite": {
      const own =
        isKeyed(given) &&
        issue.input === given &&
        isKeyed(caller) &&
        isPlain(caller);
      const found: Array<Excess.Path> = [];
      for (const inner of issue.issues) {
        const stripped = strippedFrom(inner, given, caller, path, own, isPlain);
        if (stripped === undefined) return undefined;
        found.push(...stripped);
      }
      return found;
    }
    case "Encoding":
      return strippedFrom(issue.issue, given, caller, path, owned, isPlain);
    case "AnyOf":
      for (const member of issue.issues) {
        const stripped = strippedFrom(
          member,
          given,
          caller,
          path,
          owned,
          isPlain,
        );
        if (stripped !== undefined) return stripped;
      }
      return undefined;
    default:
      return undefined;
  }
};

/** Whether a reading loses some, and only some, of the fields another loses. */
const losesLess = (
  { lost }: Decoded<unknown>,
  than: Decoded<unknown>,
): boolean => {
  if (lost.length >= than.lost.length) return false;
  const known = pathSet(than.lost);
  return lost.every((path) => known.covers(path));
};

/**
 * Try readings in their existing order. An enclosing union can skip an ambiguous alternative
 * if another member reads the whole value. A oneOf then counts the remaining complete reads.
 */
const chooseReading = (
  readings: ReadonlyArray<
    Effect.Effect<Decoded<unknown>, ReadFailure, unknown>
  >,
  keepMost: boolean,
  enclosingUnion?: SchemaAST.Union,
  countReaders = false,
) =>
  Effect.gen(function* () {
    let most: Decoded<unknown> | undefined;
    let failure: Schema.SchemaError | OptionWrapperRead | undefined;
    let ambiguity: FieldlessOneOf | undefined;
    let first: Decoded<unknown> | undefined;
    let complete: Decoded<unknown> | undefined;
    // Keep the first diagnostic, but let any provisional ambiguity trigger a loose read.
    let provisional = false;
    const matches: Array<SchemaAST.AST> = [];
    for (const [index, reading] of readings.entries()) {
      const result = yield* enclosingUnion
        ? Effect.result(reading)
        : attemptRead(reading);
      if (result._tag === "Failure") {
        if (result.failure._tag === "FieldlessOneOf") {
          ambiguity ??= result.failure;
          provisional ||= result.failure.afterAlternative === true;
        } else if (!keepMost || failure === undefined) {
          failure = result.failure;
        }
      } else if (
        result.success.lost.length === 0 ||
        (!keepMost && enclosingUnion === undefined)
      ) {
        if (!countReaders)
          return ambiguity === undefined
            ? result.success
            : afterAmbiguity(result.success, ambiguity);
        first ??= result.success;
        if (result.success.lost.length === 0) {
          complete ??= result.success;
          matches.push(enclosingUnion!.types[index]!);
        }
      } else if (most === undefined || losesLess(result.success, most)) {
        most = result.success;
      }
    }
    if (ambiguity !== undefined) {
      if (matches.length > 1)
        return yield* new FieldlessOneOf({
          path: [],
          ast: enclosingUnion!,
          matches,
        });
      if (complete !== undefined) return afterAmbiguity(complete, ambiguity);
      return yield* failure === undefined &&
      most === undefined &&
      first === undefined &&
      !provisional
        ? ambiguity
        : afterAlternative(ambiguity);
    }
    if (first !== undefined) return first;
    return most ?? (yield* Effect.fail(failure!));
  });

/** A part's input as the parent's normalised input holds it, which names only stated fields. */
const sliceOf = (given: unknown, name: PropertyKey): unknown =>
  typeof given === "object" && given !== null
    ? (given as Record<PropertyKey, unknown>)[name]
    : undefined;

/**
 * Whether a reading of a value can account for what the caller gave: it is plain data, and its schema
 * states no name every object has. What it holds is judged where a reading meets it.
 */
const accountable = (value: unknown, type: SchemaAST.AST): boolean =>
  isPlainData(value) && !statesPrototypeName(type);

/** The normalised input without the fields a parent already read as parts. */
const withoutFields = (
  given: unknown,
  read: ReadonlyArray<PropertyKey>,
): unknown => {
  if (read.length === 0 || typeof given !== "object" || given === null)
    return given;
  const fields: Record<PropertyKey, unknown> = given as never;
  return Object.fromEntries(
    Reflect.ownKeys(given)
      .filter(
        (name) =>
          !read.includes(name) &&
          Object.prototype.propertyIsEnumerable.call(given, name),
      )
      .map((name) => [name, fields[name]]),
  );
};

/** The paths an issue names, through its pointers. */
const namedPaths = (
  issue: SchemaIssue.Issue,
  path: Excess.Path = [],
): ReadonlyArray<Excess.Path> => {
  switch (issue._tag) {
    case "Pointer":
      return namedPaths(issue.issue, [...path, ...issue.path]);
    case "Encoding":
    case "Filter":
      return namedPaths(issue.issue, path);
    case "Composite":
    case "AnyOf":
      return issue.issues.flatMap((inner) => namedPaths(inner, path));
    default:
      return [path];
  }
};

/** Whether one path leads to the other, so naming either names the same field. */
const onPath = (path: Excess.Path, other: Excess.Path): boolean =>
  path.length <= other.length
    ? path.every((part, index) => part === other[index])
    : onPath(other, path);

/**
 * Lost fields without those lost only along with the ones a decoder failed beside, whose own names can
 * differ. A name of the group's own stays, because another schema there may take that one and not
 * the rest.
 */
const causing = (
  lost: ReadonlyArray<Excess.Path>,
  refused: ReadonlyArray<Refused> = [],
): ReadonlyArray<Excess.Path> =>
  refused.reduce((paths, { at, holders }) => {
    const holding = pathSet(holders);
    const isUnder = (path: Excess.Path) =>
      at.every((key, index) => path[index] === key);
    const isHeld = (path: Excess.Path) =>
      holding.covers(path) || holding.leadsOn(path);
    return paths.some((path) => isUnder(path) && isHeld(path))
      ? paths.filter(
          (path) => path.length === 1 || !isUnder(path) || isHeld(path),
        )
      : paths;
  }, lost);

/** A route's failure where the constructor's own result stands instead. */
const noRoute = new Schema.SchemaError(new SchemaIssue.InvalidValue({}));

/** A strict pass's ambiguity that only the reading after it can settle. */
const provisional = new Schema.SchemaError(new SchemaIssue.InvalidValue({}));

/** Keep the failure in case writing the alternative fails. */
const afterAmbiguity = (
  read: Decoded<unknown>,
  ambiguity: FieldlessOneOf,
): Decoded<unknown> => ({
  ...read,
  ambiguity: read.ambiguity ?? ambiguity,
});

/**
 * What these failures of readings through `ast` of what the caller gave, `given`, say about another
 * reading's losses, each failure once. Only a read with the caller's own parse options says
 * anything, so a {@link reporting} read's failure is left out.
 */
const failureCauses = (
  ast: SchemaAST.AST,
  given: unknown,
  ...failures: ReadonlyArray<Schema.SchemaError>
): ReadonlyArray<Excess.Cause> =>
  failures
    .filter(
      (failure, index) =>
        failure !== noRoute &&
        failure !== provisional &&
        !readStrictly.has(failure) &&
        failures.indexOf(failure) === index,
    )
    .map((failure) => Excess.failureCause(failure, [ast], given));

/** A reading that lost fields, with the failures of the readings it stands beside as causes. */
const explainedBy =
  (
    ast: SchemaAST.AST,
    given: unknown,
    ...failures: ReadonlyArray<Schema.SchemaError>
  ) =>
  (read: Decoded<unknown>): Decoded<unknown> => {
    if (read.lost.length === 0) return read;
    const causes = failureCauses(ast, given, ...failures);
    return causes.length === 0
      ? read
      : { ...read, causes: [...(read.causes ?? []), ...causes] };
  };

/** Only a complete reading can supersede the ambiguity. */
const keepWholeAlternative = (
  failure: FieldlessOneOf,
  alternative: () => Effect.Effect<Decoded<unknown>, ReadFailure, unknown>,
) =>
  recoverRead(
    Effect.filterOrFail(
      alternative(),
      ({ lost }) => lost.length === 0,
      () => noRoute,
    ),
    () => Effect.fail(afterAlternative(failure)),
  ).pipe(Effect.map((read) => afterAmbiguity(read, failure)));

/** The exposed spelling can change which members make up an enclosing oneOf's count. */
const changedAtAmbiguity = (
  failure: FieldlessOneOf,
  given: unknown,
  exposed: unknown,
) =>
  failure.matches.some(Excess.mayHaveOneOf) &&
  valueAt(given, failure.path) !== valueAt(exposed, failure.path);

/** A writer's own failure stands when it points outside the ambiguous position. */
const failsAtAmbiguity = (ambiguity: FieldlessOneOf, path: Excess.Path) =>
  ambiguity.path.every((key, index) => path[index] === key);

const atField = (name: PropertyKey, failure: FieldlessOneOf) =>
  new FieldlessOneOf({ ...failure, path: [name, ...failure.path] });

/** A field's own wrapper refusal, read on its own, at that field of the object holding it. */
const wrapperAtField = (name: PropertyKey, refusal: OptionWrapperRead) =>
  new OptionWrapperRead({ ...refusal, at: [name, ...refusal.at] });

/**
 * A field's failure, read on its own, at that field of the object holding it. It is still that
 * reading's failure, so a {@link reporting} read's stays one. Today only readings with the caller's
 * options reach here, so the mark is defensive: it keeps the rule if a strict read's failure is
 * ever passed in.
 */
const failureAtField = (name: PropertyKey, failure: Schema.SchemaError) => {
  const rooted = new Schema.SchemaError(
    new SchemaIssue.Pointer([name], failure.issue),
  );
  if (readStrictly.has(failure)) readStrictly.add(rooted);
  return rooted;
};

/** Whether what the caller gave is plain data at each step to a field, so the field is theirs. */
const plainAlong = (caller: unknown) => {
  const isPlain = plainness();
  return (path: Excess.Path): boolean => {
    let value = caller;
    for (const key of path) {
      if (!isKeyed(value) || !isPlain(value)) return false;
      value = value[key];
    }
    return true;
  };
};

const samePath = (path: Excess.Path, other: Excess.Path): boolean =>
  path.length === other.length &&
  path.every((key, index) => key === other[index]);

/** The parts one reading read, so routes that read the same part read it once. */
type PartsRead = Map<
  SchemaAST.AST,
  Array<{
    /** Where the part is, as two parts can hold one value and each runs its schema's own steps. */
    readonly at: Excess.Path;
    readonly value: unknown;
    readonly given: unknown;
    readonly part: boolean;
    readonly result: Result.Result<Decoded<unknown>, ReadFailure>;
  }>
>;

/**
 * Bring a value to its decoded side, as {@link decodeInput} does, and say which supplied fields that
 * lost.
 *
 * @remarks
 * Given the normalised input, every route accounts for it, so that a default cannot take the place
 * of a field the route did not read:
 *
 * - The constructor reads the decoded side and strips the rest, such as an encoded name, so what it
 *   made has to hold every supplied field. A value it returned unchanged lost nothing. Where it lost
 *   a field, it runs again strictly, which takes a union's first member that keeps everything.
 * - The decoder reads the input strictly, so it consumes every name or fails, and its failure says
 *   which names a loose read strips.
 * - Read field by field, each field is a part that accounts for its own slice, because the object's
 *   constructor runs again over the parts' results, and what that took as given has to be in what it
 *   made.
 *
 * A route that keeps everything wins. Otherwise a constructor that succeeded gives way to the route
 * that loses the fewest of the fields it lost, and after a constructor that failed the first route
 * that succeeds is taken. What that lost is refused unless another schema in the group takes it.
 *
 * Only plain data is accounted for, since only there is it certain what the caller gave. That is
 * judged place by place, so a value that is not plain data turns nothing off around it. Without the
 * normalised input a value reads as Effect reads it.
 */
const decodedReading = <S extends Schema.Top>(
  contract: S,
  {
    options,
    part = false,
    witness,
  }: {
    /** Options for every parse. */
    readonly options?: SchemaAST.ParseOptions | undefined;
    /** Whether the value is a field of one read field by field. */
    readonly part?: boolean;
    /** Whether the original input was plain at a path in this read's view. */
    readonly witness?: ((path: Excess.Path) => boolean) | undefined;
  } = {},
) => {
  // A Void never takes what it would erase, on any route.
  const guarded = guardVoids(contract.ast);
  const schema = guarded === contract.ast ? contract : Schema.make<S>(guarded);
  const canBeAmbiguous = Excess.mayHaveOneOf(guarded);
  const enclosingOneOf =
    contract.ast._tag === "Union" &&
    contract.ast.options?.mode === "oneOf" &&
    contract.ast.types.some(Excess.mayHaveOneOf);
  const classify = (
    failure: Schema.SchemaError,
    input: unknown,
    caller: unknown,
  ): ReadFailure =>
    canBeAmbiguous
      ? readFailure(
          failure,
          input,
          () => Excess.normalised([contract.ast], caller),
          caller === input
            ? witness
            : (path) =>
                hasPlainWitness(caller, path) && (witness?.(path) ?? true),
        )
      : failure;
  // A class's own constructor, which a guarded schema has not, reads nothing as no fields.
  const isClass =
    Excess.classFields(contract.ast) !== undefined && "identifier" in contract;
  /** What the constructor reads for `input`. */
  const constructedFrom = (input: unknown) => (isClass ? (input ?? {}) : input);
  const make = (
    input: unknown,
    parseOptions: SchemaAST.ParseOptions | undefined,
    caller = input,
  ) => {
    const from = constructedFrom(input);
    return Effect.mapError(
      schema.makeEffect(from, parseOptions && { parseOptions }),
      (issue) => classify(new Schema.SchemaError(issue), from, caller),
    );
  };
  const guardedReading = guardReading(guarded);
  const parse = Schema.decodeUnknownEffect(
    guardedReading === guarded ? schema : Schema.make<S>(guardedReading),
  );
  const decode = (
    input: unknown,
    parseOptions?: SchemaAST.ParseOptions,
    caller = input,
  ) => {
    const read = (opts: SchemaAST.ParseOptions | undefined) =>
      Effect.mapError(parse(input, opts), (failure) =>
        classify(failure, input, caller),
      );
    if (guardedReading === guarded) return read(parseOptions);
    return Effect.suspend(() => {
      const wrappers = new Set<Option.Option<unknown>>();
      return Effect.flatMap(
        read(recordingWrapperInto(wrappers, parseOptions)),
        (value) =>
          wrappers.size > 0
            ? Effect.fail(
                new OptionWrapperRead({
                  failure: new Schema.SchemaError(
                    new SchemaIssue.InvalidValue({
                      message: "Expected a payload without an Option wrapper",
                    }),
                  ),
                  wrappers,
                  at: [],
                }),
              )
            : Effect.succeed(value),
      );
    });
  };
  /**
   * Check the normalised input for ambiguity before a raw constructor can choose a member, where it
   * can be ambiguous, and construct it only as a fallback elsewhere.
   */
  const constructing = (
    input: unknown,
    given: unknown,
    parseOptions: SchemaAST.ParseOptions | undefined,
  ) => {
    const raw = () => make(input, parseOptions);
    if (given === undefined || given === input) return raw();
    const normalised = () => make(given, parseOptions, input);
    // Effect's constructor runs a schema's steps when it is called. Where the normalised input holds
    // nothing that can read as ambiguous, it is constructed only after the raw input fails, so a
    // value the raw constructor keeps runs them once.
    if (!canBeAmbiguous || !mayHoldFieldless(constructedFrom(given)))
      return recoverRead(raw(), (failure) =>
        recoverRead(normalised(), () => Effect.fail(failure)),
      );
    // Keep the raw reading's existing priority for its result once ambiguity is ruled out.
    return Effect.flatMap(attemptRead(normalised()), (result) =>
      recoverRead(raw(), (failure) =>
        Result.isSuccess(result)
          ? Effect.succeed(result.success)
          : Effect.fail(failure),
      ),
    );
  };
  /**
   * What a reading was given, by the normalised input, and did not keep.
   */
  const unkept = (
    input: unknown,
    given: unknown,
    value: unknown,
    sameNames: boolean,
  ) => {
    const isPlainAlong = plainAlong(input);
    return Excess.missing([contract.ast], given, value, undefined, {
      sameNames,
    }).filter(
      (path) => !readsNothing(given, value, path) && isPlainAlong(path),
    );
  };
  /**
   * What a decoder was given and left out: all of it, as a Void does of an object, or a name it
   * writes as it reads it, as the first member that fits a union does.
   */
  const leftOut = (input: unknown, given: unknown, value: unknown) =>
    unkept(input, given, value, value !== undefined);
  const byField = Effect.fnUntraced(function* (
    input: object,
    given: unknown,
    parseOptions?: SchemaAST.ParseOptions,
    parts?: PartsRead,
    at: Excess.Path = [],
    known?: { readonly name: PropertyKey; readonly field: Decoded<unknown> },
  ) {
    const output: Record<PropertyKey, unknown> = { ...input };
    // A field need not be a key, as an accessor on a class is not, so it comes from `input`.
    const fields: Record<PropertyKey, unknown> = input as never;
    const read: Array<PropertyKey> = [];
    // An own `__proto__` field is a key here, as it is in the spread copy above.
    const fieldParts: Record<PropertyKey, unknown> = Object.create(
      null,
    ) as never;
    const lost: Array<Excess.Path> = [];
    const refused: Array<Refused> = [];
    const causes: Array<Excess.Cause> = [];
    let ambiguity: FieldlessOneOf | undefined;
    for (const { name, type } of Excess.fieldsOf(contract.ast)) {
      if (fields[name] === undefined) continue;
      // A checked value is plain data, so its fields are its own data.
      const checked = given !== undefined && accountable(fields[name], type);
      const field =
        known?.name === name
          ? known.field
          : yield* Effect.catchTags(
              fromPart(type, fields[name], {
                options: parseOptions,
                part: true,
                given: checked ? sliceOf(given, name) : undefined,
                parts,
                at: [...at, name],
                witness: witness && ((path) => witness([name, ...path])),
              }),
              {
                FieldlessOneOf: (failure) =>
                  Effect.fail(atField(name, failure)),
                OptionWrapperRead: (refusal) =>
                  Effect.fail(wrapperAtField(name, refusal)),
                SchemaError: (failure) =>
                  Effect.fail(failureAtField(name, failure)),
              },
            );
      if (ambiguity === undefined && field.ambiguity !== undefined)
        ambiguity = atField(name, field.ambiguity);
      output[name] = field.value;
      fieldParts[name] = field.value;
      read.push(name);
      for (const path of field.lost) lost.push([name, ...path]);
      for (const { at: fieldPath, holders } of field.refused ?? [])
        refused.push({
          at: [name, ...fieldPath],
          holders: holders.map((path) => [name, ...path]),
        });
      for (const cause of field.causes ?? [])
        causes.push({ ...cause, at: [name, ...cause.at] });
    }
    // The constructor runs again over each part's result. Strictly, a union there keeps the member
    // the part was read by instead of taking an earlier one that strips it; loosely, as Effect would.
    // A part that was not checked does not turn that off for the others.
    // A part read as given keeps its undefined-valued keys. Read strictly again here, they make
    // members of an inner oneOf fail, and the one left would join an enclosing oneOf's count. The
    // part's own reading already settled that count, so the loose constructor decides.
    const value = yield* isKeyed(given)
      ? Effect.catch(
          make(
            { ...(withoutFields(given, read) as object), ...fieldParts },
            { ...parseOptions, onExcessProperty: "error" },
            input,
          ),
          (failure) =>
            failure._tag === "FieldlessOneOf" &&
            !changedAtAmbiguity(failure, given, input)
              ? Effect.fail(failure)
              : make(output, parseOptions, input),
        )
      : make(output, parseOptions, input);
    if (given !== undefined)
      lost.push(...unkept(input, withoutFields(given, read), value, false));
    return { value, lost, refused, ambiguity, causes };
  });
  const byMember = (
    input: object,
    failure: Schema.SchemaError,
    given: unknown,
    parseOptions?: SchemaAST.ParseOptions,
    parts?: PartsRead,
    at: Excess.Path = [],
  ) =>
    contract.ast._tag === "Union" && contract.ast.types.length > 0
      ? chooseReading(
          contract.ast.types.map((candidate) =>
            fromPart(candidate, input, {
              options: parseOptions,
              part,
              given,
              parts,
              at,
              witness,
            }),
          ),
          given !== undefined,
          contract.ast,
          enclosingOneOf,
        )
      : // A copy of a list is an object keyed by its indexes, which a record or struct could take, and
        // one of a built-in holds none of its content, so a Void could take it.
        Array.isArray(input) || contract.ast._tag === "Void"
        ? Effect.fail(failure)
        : byField(input, given, parseOptions, parts, at);
  /** Whether a struct could keep every given name by reading its fields, which have decoded names. */
  const couldKeepByField = (given: unknown) => {
    if (contract.ast._tag === "Union" || !isKeyed(given)) return true;
    const names = Excess.fieldsOf(contract.ast).map(({ name }) => name);
    return Reflect.ownKeys(given).every(
      (key) => names.includes(key) || given[key] === undefined,
    );
  };
  /**
   * Where the whole encoded read took a native Option wrapper, a struct's fields can each be read on
   * their own side, so the wrapper stays a decoded field's own value beside an encoded sibling. A
   * union keeps the refusal: read member by member, it would lose which member the whole value chose.
   * Where the fields cannot be read either, the wrapper's refusal stands. A field's own wrapper
   * refusal stands with only the wrappers that field's read took: the whole read's can include
   * wrappers the other fields keep, and the fields after it are not read
   * ([#387](https://github.com/viell-dev/slop-effect-schema-http/issues/387)).
   */
  const wrapperBesideFields = (
    input: unknown,
    refusal: OptionWrapperRead,
    fields: () => Effect.Effect<Decoded<unknown>, ReadFailure, unknown>,
  ): Effect.Effect<Decoded<unknown>, ReadFailure, unknown> =>
    contract.ast._tag === "Objects" && isKeyed(input)
      ? Effect.mapError(fields(), (error) =>
          error._tag === "SchemaError" ? refusal : error,
        )
      : Effect.fail(refusal);
  /** The routes after the constructor, as Effect reads a value. */
  const unaccounted = (
    input: unknown,
    parseOptions?: SchemaAST.ParseOptions,
  ): Effect.Effect<Decoded<unknown>, ReadFailure, unknown> =>
    Effect.matchEffect(decode(input, parseOptions), {
      onSuccess: (value) => Effect.succeed(whole(value)),
      onFailure: (failure) => {
        if (failure._tag === "OptionWrapperRead")
          return wrapperBesideFields(input, failure, () =>
            isKeyed(input)
              ? byMember(input, failure.failure, undefined, parseOptions)
              : Effect.fail(failure),
          );
        if (!isKeyed(input)) return Effect.fail(failure);
        if (failure._tag !== "FieldlessOneOf")
          return byMember(input, failure, undefined, parseOptions);
        if (!failure.insideUnion && failure.path.length === 0)
          return Effect.fail(failure);
        const retry = () => byMember(input, noRoute, undefined, parseOptions);
        const carry = (read: Decoded<unknown>) => afterAmbiguity(read, failure);
        // Each alternative reads the whole value and can rediscover the ambiguity.
        if (contract.ast._tag === "Union") return Effect.map(retry(), carry);
        const [name] = failure.path;
        const field = Array.isArray(input)
          ? undefined
          : Excess.fieldsOf(contract.ast).find(
              ({ name: fieldName }) => fieldName === name,
            );
        const value = field && sliceOf(input, field.name);
        // An encoded-only name or a container position has no fieldwise reader here.
        if (field === undefined || value === undefined)
          return keepWholeAlternative(failure, retry);
        // Let the named field settle its own ambiguity before another field can fail the retry.
        return Effect.matchEffect(
          fromPart(field.type, value, {
            options: parseOptions,
            part: true,
            given: undefined,
            parts: undefined,
            at: [field.name],
            witness: witness && ((path) => witness([field.name, ...path])),
          }),
          {
            onFailure: (own) =>
              Effect.fail(
                own._tag === "FieldlessOneOf"
                  ? atField(field.name, own)
                  : own._tag === "OptionWrapperRead"
                    ? wrapperAtField(field.name, own)
                    : afterAlternative(failure),
              ),
            onSuccess: (read) =>
              Effect.map(
                byField(input, undefined, parseOptions, undefined, [], {
                  name: field.name,
                  field: read,
                }),
                carry,
              ),
          },
        );
      },
    });
  /**
   * The decoder's strict read of what was given, or of the input where a key set to `undefined` makes
   * the two differ, and where it fails which of the caller's keys a loose read would strip. Those are
   * lost even where a decoding default fills their names again. A loose read fails too where neither
   * is known.
   */
  const decodedStrictly = Effect.fnUntraced(function* (
    input: unknown,
    given: unknown,
    parseOptions?: SchemaAST.ParseOptions,
  ) {
    let read: Decoded<unknown> | undefined;
    let stripped: ReadonlyArray<Excess.Path> | undefined;
    let refused: Schema.SchemaError | OptionWrapperRead | undefined;
    for (const from of given === input ? [given] : [given, input]) {
      const result = yield* Effect.catchTag(
        attemptRead(decode(from, { ...parseOptions, ...reporting }, input)),
        "OptionWrapperRead",
        (failure) => Effect.succeed(Result.fail(failure)),
      );
      if (result._tag === "Failure") {
        const { failure } = result;
        refused ??= failure;
        if (failure._tag === "SchemaError") {
          readStrictly.add(failure);
          stripped ??= strippedFrom(failure.issue, from, input)?.filter(
            (path) => valueAt(given, path) !== undefined,
          );
        }
        continue;
      }
      const value: unknown = result.success;
      const lost = leftOut(input, given, value);
      if (lost.length === 0)
        return { read: whole(value), stripped: [], refused };
      read ??= { value, lost, byDecoder: true };
    }
    return { read, stripped, refused };
  });
  /**
   * The routes after the constructor, each accounting for what it was given. Where every route fails,
   * `orElse` decides the failure, with the failures of the routes' reads with the caller's own parse
   * options, so that they explain the refusal without reading the value again: the loose read's,
   * where one ran, then the fieldwise reading's.
   */
  const accounted = (
    input: unknown,
    given: unknown,
    failure: Schema.SchemaError,
    parts: PartsRead,
    at: Excess.Path,
    parseOptions?: SchemaAST.ParseOptions,
    constructed = false,
    orElse?: (
      readings: ReadonlyArray<Schema.SchemaError>,
    ) => Effect.Effect<never, ReadFailure, unknown>,
  ): Effect.Effect<Decoded<unknown>, ReadFailure, unknown> => {
    const fields = () =>
      isKeyed(input) && !(constructed && !couldKeepByField(given))
        ? byMember(input, failure, given, parseOptions, parts, at)
        : Effect.fail(failure);
    const settled = (
      reading: Effect.Effect<Decoded<unknown>, ReadFailure, unknown>,
      readings: () => ReadonlyArray<Schema.SchemaError> = () => [],
    ) =>
      orElse === undefined
        ? reading
        : recoverRead(reading, () => orElse(readings()));
    return Effect.matchEffect(decodedStrictly(input, given, parseOptions), {
      onFailure: (ambiguity) =>
        ambiguity.insideUnion || ambiguity.path.length > 0
          ? settled(keepWholeAlternative(ambiguity, fields))
          : Effect.fail(ambiguity),
      onSuccess: ({ read, stripped, refused = failure }) => {
        if (
          !constructed &&
          read === undefined &&
          refused._tag === "OptionWrapperRead"
        )
          return wrapperBesideFields(
            input,
            new OptionWrapperRead({ ...refused, failure }),
            fields,
          );
        // A loose read can take another union member than a strict one and strip its names unseen.
        // If only an opaque neighbour kept the strict decoder from reading, retry a failed loose
        // read without undefined keys before deciding the encoded side cannot take the value.
        // An enclosing oneOf can also miscount on the raw spelling, so retry that count.
        const retryNormalised = (error: ReadFailure) =>
          error._tag === "OptionWrapperRead" ||
          (error._tag === "FieldlessOneOf" &&
            !changedAtAmbiguity(error, given, input))
            ? Effect.fail(error)
            : recoverRead(decode(given, parseOptions, input), () =>
                Effect.fail(error),
              );
        // These reads have the caller's own options, so their failures say what those report.
        let looseFailure: Schema.SchemaError | undefined;
        let fieldwiseFailure: Schema.SchemaError | undefined;
        // Effect's decoder starts the schema's steps when it is called, before its effect runs, so it
        // is called only where the loose route reads the value, as often as that route reads it.
        const readLoosely = () =>
          Effect.tapError(decode(input, parseOptions), (error) =>
            Effect.sync(() => {
              if (error._tag === "SchemaError") looseFailure = error;
            }),
          );
        const loose =
          stripped === undefined
            ? read === undefined
              ? Effect.fail(
                  constructed && refused._tag === "SchemaError"
                    ? refused
                    : failure,
                )
              : Effect.succeed(read)
            : constructed && Excess.choosesMemberResolved(contract.ast)
              ? Effect.fail(failure)
              : Effect.map(
                  stripped.length === 0 && given !== input
                    ? Effect.catch(readLoosely(), retryNormalised)
                    : readLoosely(),
                  (value): Decoded<unknown> => ({
                    value,
                    lost: mergePaths(stripped, leftOut(input, given, value)),
                    byDecoder: true,
                  }),
                );

        const looseRoute = constructed
          ? Effect.catchTag(loose, "OptionWrapperRead", (refusal) =>
              Effect.fail(refusal.failure),
            )
          : loose;
        const fieldwise = Effect.tapError(fields(), (error) =>
          Effect.sync(() => {
            if (error._tag === "SchemaError") fieldwiseFailure = error;
          }),
        );
        // The whole comes before its fields, as it does for Effect, unless a part's decoder would
        // strip what its fields could hold.
        const routes =
          part && stripped !== undefined && stripped.length > 0
            ? ([fieldwise, looseRoute] as const)
            : ([looseRoute, fieldwise] as const);
        // Where a route loses a field, the constructor's own error can say why.
        const explain = explainedBy(contract.ast, given, failure);
        if (read?.lost.length === 0)
          return Effect.succeed<Decoded<unknown>>({
            ...read,
            // Unlike the strict read, a loose one can take a member that strips names unseen.
            forRelaxedWrite: Effect.map(
              Excess.choosesMemberResolved(contract.ast)
                ? fieldwise
                : chooseReading(routes, false),
              explain,
            ),
          });
        // After a constructor every field means what it meant to that, so the route that keeps most
        // can be taken. Otherwise a field both sides could hold can mean something else to each.
        const chosen = Effect.map(chooseReading(routes, constructed), explain);
        return settled(
          constructed
            ? Effect.catchTag(chosen, "OptionWrapperRead", (refusal) =>
                Effect.fail(refusal.failure),
              )
            : Effect.mapError(chosen, (error) =>
                error._tag === "OptionWrapperRead"
                  ? new OptionWrapperRead({ ...error, failure })
                  : error,
              ),
          () =>
            [looseFailure, fieldwiseFailure].filter(
              (reading) => reading !== undefined,
            ),
        );
      },
    });
  };
  /**
   * A failure that reports only decoded names missing where the caller gave their wire names, with
   * the errors that the routes' reads with the caller's own options report about the caller's values
   * in those objects instead: the caller gave them on the encoded side, where `Missing key` names a
   * field they did not leave out.
   *
   * @remarks
   * No schema step runs again to find those errors, since a step can have effects of its own. They
   * come from the first of `readings` that says something of the caller's values there, each a read
   * of what was given with the caller's own parse options that ran and failed. The loose read comes
   * first: the decoder runs it beside a key it strips, and it reads the encoded side, so it can report
   * a wire-named value. The fieldwise reading reads only the fields given under their decoded names,
   * so its error, at the field it was found in, names one of those. The strict read's failure is never
   * used: Effect gave its options to every step it ran, so it can differ from what the caller's
   * options report. Where no reading says anything of the caller's values there, the failure stays as
   * it is.
   */
  const onEncodedSide = (
    failure: Schema.SchemaError,
    given: unknown,
    readings: ReadonlyArray<Schema.SchemaError>,
  ): Schema.SchemaError => {
    const holders = Excess.misnamedAt([contract.ast], given, failure.issue);
    if (holders === undefined) return failure;
    for (const reading of readings) {
      // Defensive: today every reading here was made with the caller's options.
      if (readStrictly.has(reading)) continue;
      const entries = Excess.failureWithin(
        reading.issue,
        [contract.ast],
        given,
        holders,
      );
      if (entries.length > 0) return Excess.entriesError(contract.ast, entries);
    }
    return failure;
  };
  /**
   * The failure of every route, naming the fields where only an unguarded Void could read them. A
   * field is named with what its names say, or with the failure's own error inside it, as the member
   * that refused it reports it, where the failure has one.
   */
  const erased = (
    input: unknown,
    given: unknown,
    failure: Schema.SchemaError,
    parseOptions?: SchemaAST.ParseOptions,
  ): Effect.Effect<never, Schema.SchemaError, unknown> =>
    schema === contract
      ? Effect.fail(failure)
      : Effect.matchEffect(
          Schema.decodeUnknownEffect(contract)(input, parseOptions),
          {
            onFailure: () => Effect.fail(failure),
            onSuccess: (value) => {
              const lost = unkept(input, given, value, false);
              const [first, ...others] = lost;
              return Effect.fail(
                first === undefined
                  ? failure
                  : Excess.refusal(
                      contract.ast,
                      [first, ...others],
                      [
                        ...Excess.nameCauses([contract.ast], given, lost),
                        ...failureCauses(contract.ast, given, failure),
                      ],
                      // A comparison by name finds these lost, though this reading read them.
                      Excess.readUnderOtherName(
                        [contract.ast],
                        given,
                        value,
                        lost,
                      ),
                    ),
              );
            },
          },
        );
  return (
    input: Input<S>,
    {
      parseOptions = options,
      given,
      parts = new Map(),
      at = [],
    }: {
      readonly parseOptions?: SchemaAST.ParseOptions | undefined;
      /** The parts read so far, where this value is one of them. */
      readonly parts?: PartsRead | undefined;
      /** Where this value is in the one those parts are of. */
      readonly at?: Excess.Path;
      /** The normalised input, where what the reading loses is accounted for. */
      readonly given?: unknown;
    } = {},
  ): Effect.Effect<Decoded<S["Type"]>, ReadFailure, S["DecodingServices"]> =>
    Effect.matchEffect(constructing(input, given, parseOptions), {
      onSuccess: (value) => {
        const lost =
          given === undefined || value === input
            ? []
            : unkept(input, given, value, false);
        const made = { value, lost };
        const constructed = (
          refused?: ReadonlyArray<Refused>,
          causes?: ReadonlyArray<Excess.Cause>,
        ) =>
          Effect.succeed<Decoded<S["Type"]>>({ value, lost, refused, causes });
        if (lost.length === 0) return constructed();
        // Strictly, the constructor takes a union's first member that keeps everything.
        const strictly = Effect.map(
          make(given, { ...parseOptions, onExcessProperty: "error" }, input),
          (kept): Decoded<unknown> => ({
            value: kept,
            lost: unkept(input, given, kept, false),
          }),
        );
        const keeping: Effect.Effect<
          Decoded<unknown>,
          ReadFailure,
          unknown
        > = recoverRead(
          Effect.filterOrFail(
            strictly,
            (read) => read.lost.length === 0,
            () => noRoute,
          ),
          () => accounted(input, given, noRoute, parts, at, parseOptions, true),
        );
        // Give way only to a route that loses less; otherwise keep the constructor's loss.
        return matchRead(keeping, {
          onSuccess: (read) =>
            losesLess(read, made)
              ? Effect.succeed({ ...read, forRelaxedWrite: constructed() })
              : constructed(read.refused, [
                  // The decoded side lost these, and the encoded side lost the others.
                  ...(read.byDecoder === true
                    ? Excess.mixedSides([contract.ast], given, lost, read.lost)
                    : []),
                  ...(read.causes ?? []),
                ]),
          onFailure: (failure) =>
            constructed(
              [
                {
                  at: [],
                  holders: namedPaths(failure.issue).map((path) =>
                    path.slice(0, -1),
                  ),
                },
              ],
              failureCauses(contract.ast, given, failure),
            ),
        });
      },
      onFailure: (failure) =>
        failure._tag === "FieldlessOneOf"
          ? failure.insideUnion
            ? keepWholeAlternative(failure, () =>
                given === undefined
                  ? unaccounted(input, parseOptions)
                  : accounted(input, given, noRoute, parts, at, parseOptions),
              )
            : Effect.fail(failure)
          : failure._tag === "OptionWrapperRead"
            ? Effect.fail(failure)
            : given === undefined
              ? Effect.catchTags(unaccounted(input, parseOptions), {
                  SchemaError: () => Effect.fail(failure),
                  OptionWrapperRead: (refusal: OptionWrapperRead) =>
                    Effect.fail(new OptionWrapperRead({ ...refusal, failure })),
                })
              : accounted(
                  input,
                  given,
                  failure,
                  parts,
                  at,
                  parseOptions,
                  false,
                  (readings) =>
                    erased(
                      input,
                      given,
                      onEncodedSide(failure, given, readings),
                      parseOptions,
                    ),
                ),
    }) as Effect.Effect<Decoded<S["Type"]>, ReadFailure, S["DecodingServices"]>;
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
 */
const decodeInput = <S extends Schema.Top>(
  contract: S,
  options?: SchemaAST.ParseOptions,
) => {
  const read = decodedReading(contract, { options });
  return (
    input: Input<S>,
    parseOptions = options,
  ): Effect.Effect<S["Type"], ReadFailure, S["DecodingServices"]> =>
    Effect.map(read(input, { parseOptions }), ({ value }) => value);
};

/** Read either schema side and expose the same schema failures as request preparation. */
export const toDecoded = <S extends Schema.Top>(
  contract: S,
  options?: SchemaAST.ParseOptions,
) => {
  const decode = decodeInput(contract, options);
  return (input: Input<S>, parseOptions = options) =>
    publicRead(decode(input, parseOptions), parseOptions);
};

/**
 * Read a field or union member, which may be on either side of its own schema. A member reads its
 * union's input, so it is a part only where its union is.
 */
const fromPart = (
  ast: SchemaAST.AST,
  value: unknown,
  reading: {
    /** Options for every parse. */
    readonly options: SchemaAST.ParseOptions | undefined;
    /** Whether the value is a field of one read field by field. */
    readonly part: boolean;
    /** The normalised input at this place, where what the reading loses is accounted for. */
    readonly given: unknown;
    /** The parts read so far, for a reading that is accounted for. */
    readonly parts: PartsRead | undefined;
    /** Where the part is. */
    readonly at: Excess.Path;
    readonly witness: ((path: Excess.Path) => boolean) | undefined;
  },
): Effect.Effect<Decoded<unknown>, ReadFailure, unknown> => {
  const { options, part, given, parts, at, witness } = reading;
  const read = decodedReading(Schema.make<Schema.Top>(ast), {
    options,
    part,
    witness,
  });
  if (given === undefined || parts === undefined) return read(value, { given });
  // Routes meet the same part again and again, so it runs its schema's own effects once.
  return Effect.suspend(() => {
    let known = parts.get(ast);
    if (known === undefined) parts.set(ast, (known = []));
    const before = known.find(
      (entry) =>
        Object.is(entry.value, value) &&
        samePath(entry.at, at) &&
        Object.is(entry.given, given) &&
        entry.part === part,
    );
    if (before !== undefined) return Effect.fromResult(before.result);
    return Effect.flatMap(
      Effect.result(read(value, { given, parts, at })),
      (result) => {
        known.push({ at, value, given, part, result });
        return Effect.fromResult(result);
      },
    );
  });
};

/** What a schema wrote, and the fields of its input it would lose, which may be held elsewhere. */
export interface Written<A> {
  readonly output: A;
  readonly lost: ReadonlyArray<Excess.Path>;
  /** Why fields in `lost` were lost, where more is known than the loss. */
  readonly causes?: ReadonlyArray<Excess.Cause> | undefined;
  readonly ambiguity?: FieldlessOneOf | undefined;
  /**
   * The fields in `lost` that only the write lost, after the first member that could not write the
   * value gave way to one that strips them, and that member's failure.
   */
  readonly unwritten?: {
    readonly lost: ReadonlyArray<Excess.Path>;
    readonly failure: Schema.SchemaError;
  };
}

/** Paths held by their parts, so a lookup costs one step per part. */
const pathSet = (paths: Iterable<Excess.Path> = []) => {
  interface Node {
    end: boolean;
    readonly next: Map<PropertyKey, Node>;
  }
  const root: Node = { end: false, next: new Map() };
  const nodeFor = (path: Excess.Path, create: boolean): Node | undefined => {
    let node: Node | undefined = root;
    for (const part of path) {
      let next: Node | undefined = node.next.get(part);
      if (next === undefined) {
        if (!create) return undefined;
        next = { end: false, next: new Map() };
        node.next.set(part, next);
      }
      node = next;
    }
    return node;
  };
  const set = {
    has: (path: Excess.Path) => nodeFor(path, false)?.end === true,
    /** Whether a path leads to a longer one in the set. */
    leadsOn: (path: Excess.Path) => (nodeFor(path, false)?.next.size ?? 0) > 0,
    /** Whether a path, or one that leads to it, is in the set. */
    covers: (path: Excess.Path) => {
      let node: Node | undefined = root;
      for (const part of path) {
        if (node.end) return true;
        node = node.next.get(part);
        if (node === undefined) return false;
      }
      return node.end;
    },
    /** Add a path, and say whether it was new. */
    add: (path: Excess.Path) => {
      const node = nodeFor(path, true)!;
      if (node.end) return false;
      node.end = true;
      return true;
    },
  };
  for (const path of paths) set.add(path);
  return set;
};

const valueAt = (value: unknown, path: Excess.Path): unknown =>
  path.reduce<unknown>(
    (held, key) => (isKeyed(held) ? held[key] : undefined),
    value,
  );

/** Whether a value has a key, whatever it holds there. */
const holdsKey = (value: unknown, path: Excess.Path): boolean => {
  const holder = valueAt(value, path.slice(0, -1));
  return isKeyed(holder) && path.at(-1)! in holder;
};

/** Whether a value that holds nothing was read as `undefined` in place, as a Void reads it. */
const readsNothing = (
  given: unknown,
  value: unknown,
  path: Excess.Path,
): boolean =>
  Excess.holdsNothing(valueAt(given, path)) && holdsKey(value, path);

/** Losses from separate checks, each listing a path once. A single list is returned as it is. */
const mergePaths = (
  ...lists: ReadonlyArray<ReadonlyArray<Excess.Path>>
): ReadonlyArray<Excess.Path> => {
  const filled = lists.filter((list) => list.length > 0);
  if (filled.length <= 1) return filled[0] ?? [];
  const seen = pathSet();
  return filled.flat().filter((path) => seen.add(path));
};

/**
 * A strict write's failure as the first member that could not write the value reports it, at each
 * union, in member order and through nested unions. A member that only names keys it does not
 * state could write the value by stripping them, and a guarded Void declines it, so neither is
 * that member. Undefined if every member only strips or declines.
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
      for (const member of issue.issues) {
        if (declinedByVoid(member)) continue;
        const inner = unwritable(member);
        if (inner !== undefined) return inner;
      }
      return undefined;
    }
    default:
      return issue;
  }
};

/**
 * The failure of the first member that could not write, at each union where a later member dropped
 * a supplied field, as that member alone reports it. Undefined where a drop has no such member.
 */
const writeFailure = (
  ast: SchemaAST.AST,
  dropped: ReadonlyArray<Dropped>,
): Schema.SchemaError | undefined => {
  const unions = pathSet();
  const issues: Array<SchemaIssue.Issue> = [];
  for (const { union, before } of dropped) {
    if (union === undefined || before === undefined) return undefined;
    if (!unions.add(union)) continue;
    const issue = unwritable(before) ?? before;
    issues.push(
      union.length === 0 ? issue : new SchemaIssue.Pointer(union, issue),
    );
  }
  const [first, ...others] = issues;
  if (first === undefined) return undefined;
  return new Schema.SchemaError(
    others.length === 0
      ? first
      : new SchemaIssue.Composite(ast, [first, ...others]),
  );
};

/** Takes a decoded value out through a schema, as the options say. */
type Write<S extends Schema.Top, A, R> = (
  value: S["Type"],
  options?: SchemaAST.ParseOptions,
) => Effect.Effect<A, Schema.SchemaError, R>;

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
 * A value that cannot be read that way is read with every route accounting for what it was given,
 * and the result is compared with what went in. The write is strict first, because a loose write can
 * choose another member and lose what the read kept. The loose write tries each union's members
 * strictly first too and notes which wrote each value, and a field that member does not state is
 * lost, since its struct drops the field before anything else it does runs.
 *
 * The strict pass also gives a visible object or list a chance to win over Void in an any-of union.
 */
const readerForCodec = <S extends Schema.Top, A, R>(
  contract: S,
  codec: Schema.ConstraintCodec<S["Type"], A, unknown, R>,
  custom?: Write<S, A, R>,
  canonicalJson = false,
) => {
  const guarded = guardVoids(codec.ast);
  const guardedCodec =
    guarded === codec.ast ? codec : Schema.make<typeof codec>(guarded);
  const write = custom ?? Schema.encodeEffect(guardedCodec);
  const decoded = decodeInput(contract);
  const ast = contract.ast;
  // The same positions, compared on the way in and on the way out of the schema.
  const rebuildLoss = Excess.rebuildLoss(ast, canonicalJson);
  const losses = (
    input: unknown,
    value: unknown,
    output: unknown,
    unstated?: boolean,
  ): Excess.Losses =>
    rebuildLoss?.(input, value, output, unstated) ?? { lost: [], causes: [] };
  const written = (
    input: unknown,
    reading: ReturnType<typeof decoded>,
    options?: SchemaAST.ParseOptions,
  ) =>
    Effect.flatMap(reading, (value) =>
      Effect.map(write(value, options), (output): Written<A> => ({
        output,
        ...losses(input, value, output),
      })),
    );
  if (!Excess.choosing(ast))
    return (input: Input<S>) => written(input, decoded(input));
  // A custom writer is the caller's own, except that it knows no guard.
  const strictWriter =
    guarded === codec.ast ? write : Schema.encodeEffect(guardedCodec);
  // Only the built-in writer establishes how a codec exposes a Some on the wire. A configured codec,
  // such as OptionFromOptionalNullOr with an onNoneEncoding, exposes a Some's payload as the other
  // built-in codecs do, so its unstated keys are left out before the strict read too. The relaxed
  // route compares the Somes that codecs unwrap with what the caller gave, including those of codecs
  // whose payload preparation cannot find on the wire, such as a hand-written one, as optionLoss
  // says.
  const writesUnwrappedOptions =
    custom === undefined && Excess.mayWriteUnwrappedOption(ast);
  const readOriginal = decodedReading(contract);
  const readingFrom = (input: Input<S>, caller: Input<S>) =>
    caller === input
      ? readOriginal
      : decodedReading(contract, {
          witness: (path) => hasPlainWitness(caller, path),
        });
  /**
   * The strict pass's refusal of the native Options its decoder took as wire values, which no later
   * route reads again. It carries the strict constructor's failure, and no reading with the caller's
   * own parse options runs on this route, so each wrapper the refusing read took is named where it
   * was given, as one the schema cannot keep with the rest of the value. Where a field's own read
   * refuses, those are that field's wrappers only, found in that field, and another refused wrapper
   * can go unnamed ([#387](https://github.com/viell-dev/slop-effect-schema-http/issues/387)). Only a
   * place where a reader of the guarded schema notes wrappers counts, since every `None` is one
   * object. A wrapper found nowhere, such as one behind an accessor, names the whole value.
   */
  const strictWrapperRefusal = (
    from: unknown,
    refusal: OptionWrapperRead,
  ): OptionWrapperRead => {
    const places = Excess.placesOf(
      guardReading(guardVoids(ast)),
      from,
      refusal.wrappers,
      notesWrapper,
      refusal.at,
    );
    return new OptionWrapperRead({
      ...refusal,
      failure: Excess.refusal(ast, Arr.isArrayNonEmpty(places) ? places : [[]]),
    });
  };
  /** A value a strict read took as it was, and why it cannot be written strictly. */
  interface Unwritable {
    readonly read: Decoded<S["Type"]>;
    readonly failure: Schema.SchemaError;
  }
  /** A strict read written strictly, or the value it read where only the write failed. */
  type Kept = { readonly written: Written<A> } | Unwritable;
  // The root is accounted for where its value is plain data and its schema names nothing every
  // object has; its parts are then each checked as they are. The schema is asked on the first read,
  // so building an encoder runs no suspended schema.
  const readDecoded = (input: Input<S>, given: unknown, caller: Input<S>) =>
    readingFrom(input, caller)(input, {
      given: accountable(input, ast) ? given : undefined,
    });
  // A custom writer is the caller's own. Only the schema's own writer can note its members.
  const recordingAst =
    custom === undefined || strictWriter !== write
      ? recordingWriter(guarded)
      : undefined;
  const recordingWrite =
    recordingAst &&
    Schema.encodeEffect(Schema.make<typeof codec>(recordingAst));
  /** What a write sent, the strict failure a loose write followed, and who wrote each value. */
  interface Sent {
    readonly output: A;
    readonly strict?: Schema.SchemaError;
    readonly writers?: WriterNotes | undefined;
  }
  /** The loose write, and which member wrote each value where the writer can say. */
  const looseWrite = (
    value: S["Type"],
  ): Effect.Effect<Sent, Schema.SchemaError, R> => {
    if (recordingWrite === undefined)
      return Effect.map(strictWriter(value), (output) => ({
        output,
        writers: undefined,
      }));
    const writers: WriterNotes = [];
    return Effect.map(
      recordingWrite(value, recordingInto(writers)),
      (output) => ({ output, writers }),
    );
  };
  type SentRead = Effect.Effect<
    Sent & { readonly read: Decoded<S["Type"]> },
    ReadFailure,
    R | S["DecodingServices"]
  >;
  /** The read and what it wrote, strictly or else loosely. */
  const sendRead = (read: Decoded<S["Type"]>): SentRead =>
    Effect.catchTag(
      Effect.map(
        strictWriter(read.value, Excess.strict),
        (output): Sent & { readonly read: typeof read } => ({ output, read }),
      ),
      "SchemaError",
      (strict) => sendLoosely(read, strict),
    );
  /** What a read wrote loosely, once its strict write failed with `strict`. */
  const sendLoosely = (
    read: Decoded<S["Type"]>,
    strict: Schema.SchemaError,
  ): SentRead => {
    // Relax excess-property handling while keeping any Void guard on the writer.
    const loose = Effect.map(looseWrite(read.value), (sent) => ({
      ...sent,
      strict,
      read,
    }));
    const exhausted = (failure: Schema.SchemaError) =>
      Effect.fail(
        read.ambiguity !== undefined &&
          namedPaths(failure.issue).every((path) =>
            failsAtAmbiguity(read.ambiguity!, path),
          )
          ? read.ambiguity
          : failure,
      );
    if (read.forRelaxedWrite === undefined)
      return recoverRead(loose, exhausted);
    const relaxed = Effect.flatMap(
      read.forRelaxedWrite as Effect.Effect<
        typeof read,
        ReadFailure,
        S["DecodingServices"]
      >,
      sendRead,
    );
    return recoverRead(
      Effect.catchTag(loose, "SchemaError", () => relaxed),
      exhausted,
    );
  };
  /**
   * Read a value accounting for what that loses, or take a strict read that stripped nothing, write
   * it, and compare the result with what went in. A strict read's value is written loosely, as its
   * strict write already failed.
   */
  const compared = (
    input: Input<S>,
    given: unknown,
    strictly?: Unwritable,
    from = input,
  ) =>
    Effect.suspend(() =>
      Effect.map(
        strictly === undefined
          ? Effect.flatMap(readDecoded(from, given, input), sendRead)
          : sendLoosely(strictly.read, strictly.failure),
        ({
          output,
          strict,
          writers,
          read: {
            value,
            lost: lostByRead,
            refused,
            ambiguity,
            causes: causesByRead,
          },
        }): Written<A> => {
          // A field more than one comparison reports is named once.
          const isHeld = (path: Excess.Path) =>
            !readsNothing(given, value, path);
          // A strict read whose strict write failed may have kept an instance holding a field its
          // class does not state, which the class drops without a trace. What every class's value
          // holds outside its fields is then compared as any rebuild is, as on 0.20.0.
          const rebuilt = losses(input, value, output, strictly !== undefined);
          const lost = causing(
            mergePaths(
              // What a strict read kept as given, only what was written can say it holds.
              Excess.missing([ast], given, value, output, {
                written: strictly !== undefined,
              }).filter(isHeld),
              rebuilt.lost,
              lostByRead,
              writesUnwrappedOptions
                ? Excess.optionLoss(ast, given, value, output, {
                    checkWrite: strict !== undefined,
                    codecsWithoutSource: true,
                  })
                : [],
            ),
            refused,
          );
          const dropped =
            strict === undefined || writers === undefined
              ? []
              : droppedBy(guarded, { given, value, caller: input }, writers);
          const paths = dropped.map(({ path }) => path);
          const all = mergePaths(lost, paths);
          // What is known of why each field is lost, from its names, its place or another reading.
          const causes =
            all.length === 0
              ? undefined
              : [
                  ...Excess.nameCauses([ast], given, all),
                  ...rebuilt.causes,
                  ...(causesByRead ?? []),
                ];
          if (dropped.length === 0) return { output, lost, causes, ambiguity };
          const failure = writeFailure(ast, dropped);
          return {
            output,
            lost: all,
            causes,
            ambiguity,
            ...(failure !== undefined && {
              unwritten: { lost: paths, failure },
            }),
          };
        },
      ),
    );
  const reading = (
    input: Input<S>,
    cleaned: Input<S>,
  ): Effect.Effect<Written<A>, ReadFailure, R | S["DecodingServices"]> => {
    const changed = cleaned !== input;
    const given = Excess.normalised([ast], cleaned);
    // A strict read cannot see a field outside a value's keys, so it may not fall back on `input`.
    const seen = (
      given === cleaned ? cleaned : Excess.exposed([ast], cleaned)
    ) as Input<S>;
    const kept = (from: Input<S>) => {
      return Effect.flatMap(
        Effect.catchTag(
          readingFrom(from, input)(from, { parseOptions: Excess.strict }),
          "OptionWrapperRead",
          (refusal) => Effect.fail(strictWrapperRefusal(from, refusal)),
        ),
        (read) =>
          Effect.match(strictWriter(read.value, Excess.strict), {
            onSuccess: (output): Kept => {
              const rebuilt = losses(from, read.value, output);
              return {
                written: {
                  output,
                  lost: mergePaths(
                    rebuilt.lost,
                    changed
                      ? Excess.optionLoss(ast, from, read.value, output, {
                          looseRead: true,
                        })
                      : [],
                  ),
                  causes: rebuilt.causes,
                  ambiguity: read.ambiguity,
                },
              };
            },
            onFailure: (failure): Kept => ({ read, failure }),
          }),
      );
    };
    // A strict pass refuses keys Effect strips. Where its ambiguity rests on another reading having
    // failed, that reading may have failed on such a key alone, so the pass ends as any strict
    // failure does and the reading below decides.
    const strictly = (
      read: Effect.Effect<Kept, ReadFailure, R | S["DecodingServices"]>,
    ) =>
      Effect.catchTag(read, "FieldlessOneOf", (failure) =>
        Effect.fail(failure.afterAlternative ? provisional : failure),
      );
    const recoverExposed = (read: ReturnType<typeof kept>) =>
      Effect.catchTag(read, "FieldlessOneOf", (failure) =>
        Effect.fail(
          failure.afterAlternative || changedAtAmbiguity(failure, given, seen)
            ? provisional
            : failure,
        ),
      );
    const attempt = (): Effect.Effect<
      Kept,
      ReadFailure,
      R | S["DecodingServices"]
    > => {
      if (given === cleaned) return strictly(kept(cleaned));
      // Effect's constructor and decoder run a schema's steps when they are called, so the exposed
      // value is read only on the routes below that use it.
      const second = () => recoverExposed(kept(seen));
      return matchRead(strictly(kept(given as Input<S>)), {
        // The exposed value is not read after a provisional ambiguity: read strictly, its
        // undefined-valued keys make members fail, and the one left would be chosen.
        onFailure: (failure) =>
          failure === provisional ? Effect.fail(failure) : second(),
        // Keep the normalized read if it settled an ambiguity. The exposed input could make a
        // member of the ambiguous union fail on an undefined-valued key and admit the other.
        // Otherwise the first read stands where the second does not write strictly either.
        onSuccess: (first) =>
          "written" in first || first.read.ambiguity !== undefined
            ? Effect.succeed(first)
            : recoverRead(
                Effect.filterOrFail(
                  second(),
                  (next) => "written" in next,
                  () => noRoute,
                ),
                () => Effect.succeed(first),
              ),
      });
    };
    // A cleaned payload can be used only by the strict read and write.
    if (changed)
      return Effect.flatMap(attempt(), (result) =>
        "written" in result
          ? Effect.succeed(result.written)
          : Effect.fail(result.failure),
      );
    const loose = () => compared(input, given);
    return matchRead(attempt(), {
      onFailure: () =>
        canonicalJson && given !== input
          ? recoverRead(loose(), (failure) =>
              recoverRead(
                Effect.filterOrFail(
                  compared(input, given, undefined, given as Input<S>),
                  ({ lost }) => lost.length === 0,
                  () => noRoute,
                ),
                () => Effect.fail(failure),
              ),
            )
          : loose(),
      onSuccess: (strict) => {
        if ("written" in strict) return Effect.succeed(strict.written);
        const loosely = loose();
        // A strict read that passed stripped nothing, but a loose read can take an earlier member
        // that strips a value that is not plain data, as a class instance is. Where that is
        // refused, the loose write takes the strict read instead, if it keeps every field. A strict
        // read counts a field a value inherits as a key, so where the schema names a field every
        // object has, the read would guess what Effect 4.0.7 and 4.1.4 read differently.
        if (statesPrototypeNameAnywhere(ast)) return loosely;
        return Effect.flatMap(attemptRead(loosely), (result) => {
          return result._tag === "Success" && result.success.lost.length === 0
            ? Effect.succeed(result.success)
            : recoverRead(
                Effect.filterOrFail(
                  compared(input, given, strict),
                  ({ lost }) => lost.length === 0,
                  () => noRoute,
                ),
                () => Effect.fromResult(result),
              );
        });
      },
    });
  };
  return (input: Input<S>) => {
    const cleaned = writesUnwrappedOptions
      ? (Excess.normalisedOptions(ast, input) as Input<S>)
      : input;
    if (cleaned === input) return reading(input, input);
    // A typed failure from the strict attempt may come from an opaque neighbour. Only the
    // caller's original input may use the ordinary reader and its relaxed route.
    return recoverRead(reading(input, cleaned), () => reading(input, input));
  };
};

const reading = <S extends Schema.Top>(
  contract: S,
  write?: Write<S, S["Encoded"], S["EncodingServices"]>,
) =>
  readerForCodec<S, S["Encoded"], S["EncodingServices"]>(
    contract,
    contract,
    write,
  );

export const reader = <S extends Schema.Top>(
  contract: S,
  write?: Write<S, S["Encoded"], S["EncodingServices"]>,
) => {
  const read = reading(contract, write);
  return (input: Input<S>) => publicRead(read(input));
};

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
    return reading(reordered);
  });
};

/**
 * Refuse the fields a schema would lose, unless another schema in the group took them, as `taken`
 * says. Only a field of the group itself can be taken, so one further down a value stays lost. A refusal names the
 * innermost fields, so it never names a field beside one inside it.
 *
 * Where only the write lost them, the refusal is the failure of the member that could not write
 * them, as that member alone would refuse. Otherwise each field is named with what the reading's
 * `causes` say about it, or else as one the schema cannot keep.
 */
export const refuseLost = (
  contract: Schema.Top,
  {
    lost,
    unwritten,
    causes,
  }: Pick<Written<unknown>, "lost" | "unwritten" | "causes">,
  taken?: (name: PropertyKey) => boolean,
): Effect.Effect<void, Schema.SchemaError> => {
  const remaining = lost.filter(
    (path) => path.length > 1 || taken?.(path[0]!) !== true,
  );
  if (remaining.length === 0) return Effect.void;
  // The member's failure stands in only if it names every field still uncovered; a field another
  // stacked schema took may be the one it names.
  const explains = (failure: Schema.SchemaError, written: Excess.Path[]) => {
    const writes = pathSet(written);
    const named = namedPaths(failure.issue);
    return remaining.every(
      (path) => writes.has(path) && named.some((other) => onPath(other, path)),
    );
  };
  if (
    unwritten !== undefined &&
    explains(unwritten.failure, [...unwritten.lost])
  )
    return Effect.fail(unwritten.failure);
  // Separate checks can report a field and one inside it. Naming the inner one says both.
  const named = pathSet(remaining);
  const [first, ...others] = remaining.filter((path) => !named.leadsOn(path));
  return Effect.fail(Excess.refusal(contract.ast, [first!, ...others], causes));
};

/** Bring a value to the schema's decoded side and write it, with nothing else to hold what it loses. */
const encodeWith = <S extends Schema.Top, A, R, B, E, R2>(
  contract: S,
  codec: Schema.ConstraintCodec<S["Type"], A, unknown, R>,
  finish: (value: A) => Effect.Effect<B, E, R2>,
  canonicalJson = false,
) => {
  if (
    !Excess.choosing(contract.ast) &&
    Excess.rebuildLoss(contract.ast, canonicalJson) === undefined
  ) {
    const decoded = decodeInput(contract);
    const guarded = guardVoids(codec.ast);
    const write = Schema.encodeEffect(
      guarded === codec.ast ? codec : Schema.make<typeof codec>(guarded),
    );
    return (input: Input<S>) =>
      Effect.flatMap(publicRead(Effect.flatMap(decoded(input), write)), finish);
  }
  const read = readerForCodec(contract, codec, undefined, canonicalJson);
  return (input: Input<S>) =>
    Effect.flatMap(publicRead(read(input)), ({ output, ambiguity, ...loss }) =>
      Effect.flatMap(
        refuseLost(contract, loss),
        (): Effect.Effect<B, E | Schema.SchemaError, R2> =>
          ambiguity === undefined
            ? finish(output)
            : Effect.mapError(finish(output), (failure) => {
                const cause =
                  failure instanceof Error ? failure.cause : undefined;
                return isWriterError(cause) &&
                  isBodyWriteError(cause) &&
                  failsAtAmbiguity(ambiguity, cause.path)
                  ? publicAmbiguity(ambiguity)
                  : failure;
              }),
      ),
    );
};

/** Read either schema side and write it, with nothing else to hold what the reading loses. */
export const encoder = <S extends Schema.Top, A, R>(
  contract: S,
  codec: Schema.ConstraintCodec<S["Type"], A, unknown, R>,
) => encodeWith(contract, codec, (value: A) => Effect.succeed(value));

/** Write canonical JSON, preserving the read failure if the enclosing alternative cannot write. */
export const jsonEncoder = <S extends Schema.Top, A, R, B, E, R2>(
  contract: S,
  codec: Schema.ConstraintCodec<S["Type"], A, unknown, R>,
  finish: (value: A) => Effect.Effect<B, E, R2>,
) => encodeWith(contract, codec, finish, true);
