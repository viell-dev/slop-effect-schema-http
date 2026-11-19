import { Effect, Schema, SchemaAST, SchemaIssue } from "effect";
import { encodedInput } from "./encoded-input.js";
import * as Excess from "./excess.js";
import { nestedEncodedInput } from "./nested-input.js";
import {
  isPlainData,
  isPlainDataThroughout,
  statesPrototypeName,
} from "./plain.js";
import { snapshotter } from "./snapshot.js";
import { guardVoidMembers, observeVoid } from "./void-member.js";
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

/** A decoded value, and the fields its parts were given and did not keep, from this value. */
interface Decoded<A> {
  readonly value: A;
  readonly lost: ReadonlyArray<Excess.Path>;
}

const whole = <A>(value: A): Decoded<A> => ({ value, lost: [] });

/** Parse options for a strict read that reports every issue with the object it was found in. */
const reporting: SchemaAST.ParseOptions = {
  onExcessProperty: "error",
  errors: "all",
  reportInput: true,
};

/**
 * The caller's keys a loose read would strip, from a {@link reporting} read's failure, or undefined
 * where a loose read fails too.
 *
 * @remarks
 * A strict and a loose read part only on excess keys. A key counts as the caller's when the object
 * it was found in is the caller's own object at that place, as a part's normalised input holds it.
 * A checked part is plain data, so that input holds only the caller's own fields. A decoder or
 * transformation makes a new object, so a key it adds is not the caller's. A union takes its first
 * member that only strips, as a loose read would.
 */
const strippedFrom = (
  issue: SchemaIssue.Issue,
  given: unknown,
  path: Excess.Path = [],
  owned = false,
): ReadonlyArray<Excess.Path> | undefined => {
  switch (issue._tag) {
    case "UnexpectedKey":
      return [];
    case "Pointer": {
      const at = [...path, ...issue.path];
      if (issue.issue._tag === "UnexpectedKey") return owned ? [at] : [];
      const below = owned
        ? issue.path.reduce<unknown>(
            (value, key) => (isKeyed(value) ? value[key] : undefined),
            given,
          )
        : undefined;
      return strippedFrom(issue.issue, below, at);
    }
    case "Composite": {
      const own = isKeyed(given) && issue.input === given;
      const found: Array<Excess.Path> = [];
      for (const inner of issue.issues) {
        const stripped = strippedFrom(inner, given, path, own);
        if (stripped === undefined) return undefined;
        found.push(...stripped);
      }
      return found;
    }
    case "Encoding":
      return strippedFrom(issue.issue, given, path, owned);
    case "AnyOf":
      for (const member of issue.issues) {
        const stripped = strippedFrom(member, given, path, owned);
        if (stripped !== undefined) return stripped;
      }
      return undefined;
    default:
      return undefined;
  }
};

/** The first reading that keeps everything, or else the first that succeeds, in member order. */
const keepingFirst = (
  readings: ReadonlyArray<
    Effect.Effect<Decoded<unknown>, Schema.SchemaError, unknown>
  >,
) =>
  Effect.gen(function* () {
    let lossy: Decoded<unknown> | undefined;
    let failure: Schema.SchemaError | undefined;
    for (const reading of readings) {
      const result = yield* Effect.result(reading);
      if (result._tag === "Failure") failure ??= result.failure;
      else if (result.success.lost.length === 0) return result.success;
      else lossy ??= result.success;
    }
    if (lossy !== undefined) return lossy;
    return yield* Effect.fail(failure!);
  });

/** A part's input as the parent's normalised input holds it, which names only stated fields. */
const sliceOf = (given: unknown, name: PropertyKey): unknown =>
  typeof given === "object" && given !== null
    ? (given as Record<PropertyKey, unknown>)[name]
    : undefined;

/**
 * Whether a field read on its own is checked: it is plain data throughout, and its schema states no
 * name every object has, at any depth. Each check of a part reads all of it, so the whole of it has
 * to be what the caller gave.
 */
const plainPart = (value: unknown, type: SchemaAST.AST): boolean =>
  isPlainDataThroughout(value) && !statesPrototypeName(type, true);

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

/**
 * Bring a value to its decoded side, as {@link toDecoded} does, and keep the evidence of what its
 * parts lost.
 *
 * @remarks
 * A part is a field read on its own. Given the parent's normalised input for it, every route a part
 * takes accounts for what it was given, because the parent's constructor runs again over the part's
 * result and would fill a default where the part lost a field:
 *
 * - The constructor reads the decoded side and strips the rest, such as an encoded name, so what it
 *   made has to hold every supplied field. A value it returned unchanged lost nothing.
 * - The decoder reads the normalised input strictly, so it consumes every name or fails. Effect's
 *   strict read takes a union's first member that keeps everything.
 * - Read field by field, each field is a part, and what the parent's constructor took as given has
 *   to be in what it made.
 * - A decoder that has to strip is the last route, and what it lost is kept.
 *
 * A route that keeps everything wins. Otherwise the constructor's loss, or the first later route's,
 * is kept, so the request is refused. Without that input, a part reads as Effect reads it, and so
 * does one that is not plain data throughout, as {@link plainPart} says.
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
  /** What a route was given, by the parent's normalised input, and did not keep. */
  const unkept = (given: unknown, value: unknown) =>
    Excess.missing([contract.ast], given, value, undefined);
  const byField = Effect.fnUntraced(function* (
    input: object,
    given: unknown,
    parseOptions?: SchemaAST.ParseOptions,
    onFieldwise?: () => void,
  ) {
    const output: Record<PropertyKey, unknown> = { ...input };
    // A field need not be a key, as an accessor on a class is not, so it comes from `input`.
    const fields: Record<PropertyKey, unknown> = input as never;
    const read: Array<PropertyKey> = [];
    // An own `__proto__` field is a key here, as it is in the spread copy above.
    const parts: Record<PropertyKey, unknown> = Object.create(null) as never;
    const lost: Array<Excess.Path> = [];
    for (const { name, type } of Excess.fieldsOf(contract.ast)) {
      if (fields[name] === undefined) continue;
      // A checked value is plain data, so its fields are its own data. A part of a part is checked
      // where the part is; another is checked where it is plain data throughout.
      const checked =
        given !== undefined && (part || plainPart(fields[name], type));
      const field = yield* fromPart(type, fields[name], {
        options: parseOptions,
        part: true,
        given: checked ? sliceOf(given, name) : undefined,
      });
      output[name] = field.value;
      parts[name] = field.value;
      read.push(name);
      for (const path of field.lost) lost.push([name, ...path]);
    }
    // The constructor runs again over each part's result. Strictly, a union there keeps the member
    // the part was read by instead of taking an earlier one that strips it; loosely, as Effect would.
    const value = yield* isKeyed(given)
      ? Effect.catch(
          make(
            { ...(withoutFields(given, read) as object), ...parts },
            { ...parseOptions, onExcessProperty: "error" },
          ),
          () => make(output, parseOptions),
        )
      : make(output, parseOptions);
    onFieldwise?.();
    // The root's encoded-only names have their own proof; a part's are checked here.
    if (part && given !== undefined)
      lost.push(...unkept(withoutFields(given, read), value));
    return { value, lost };
  });
  const byMember = (
    input: object,
    failure: Schema.SchemaError,
    given: unknown,
    parseOptions?: SchemaAST.ParseOptions,
    onFieldwise?: () => void,
  ) =>
    contract.ast._tag === "Union" && contract.ast.types.length > 0
      ? (part && given !== undefined ? keepingFirst : Effect.firstSuccessOf)(
          contract.ast.types.map((member) =>
            fromPart(member, input, {
              options: parseOptions,
              part,
              given,
              onFieldwise,
            }),
          ),
        )
      : // A copy of a list is an object keyed by its indexes, which a record or struct could take.
        Array.isArray(input)
        ? Effect.fail(failure)
        : byField(input, given, parseOptions, onFieldwise);
  /** The routes after the constructor, as Effect reads a value. */
  const afterConstruction = (
    input: unknown,
    given: unknown,
    parseOptions?: SchemaAST.ParseOptions,
    onFieldwise?: () => void,
  ): Effect.Effect<Decoded<unknown>, Schema.SchemaError, unknown> =>
    Effect.catch(
      Effect.map(decode(input, parseOptions), whole),
      (encodedFailure) =>
        typeof input === "object" && input !== null
          ? byMember(input, encodedFailure, given, parseOptions, onFieldwise)
          : Effect.fail(encodedFailure),
    );
  /** The routes after a part's constructor, each accounting for what it was given. */
  const accounted = (
    input: unknown,
    given: unknown,
    parseOptions?: SchemaAST.ParseOptions,
    onFieldwise?: () => void,
  ): Effect.Effect<Decoded<unknown>, Schema.SchemaError, unknown> =>
    Effect.catch(
      Effect.map(decode(given, { ...parseOptions, ...reporting }), whole),
      (strictFailure) => {
        // The strict failure says which of the caller's keys a loose read would strip, if a loose
        // read succeeds at all; do not run the decoder again where it would fail the same way. The
        // keys are lost even where a decoding default fills their names again.
        const stripped = strippedFrom(strictFailure.issue, given);
        const loose =
          stripped === undefined
            ? Effect.fail(strictFailure)
            : Effect.map(
                decode(input, parseOptions),
                (value): Decoded<unknown> => ({ value, lost: stripped }),
              );
        const fieldwise = isKeyed(input)
          ? byMember(input, strictFailure, given, parseOptions, onFieldwise)
          : Effect.fail(strictFailure);
        // A loose read that strips only keys a decoder made keeps what the caller gave, and comes
        // first, as it does for Effect.
        return stripped?.length === 0
          ? Effect.catch(loose, () => fieldwise)
          : Effect.catch(fieldwise, () => loose);
      },
    );
  return (
    input: Input<S>,
    onConstructed?: () => void,
    onFieldwise?: () => void,
    parseOptions = options,
    given?: unknown,
  ): Effect.Effect<
    Decoded<S["Type"]>,
    Schema.SchemaError,
    S["DecodingServices"]
  > => {
    const checked = part && given !== undefined;
    return Effect.matchEffect(make(input, parseOptions), {
      onSuccess: (value) => {
        // Observe only the initial whole constructor, outside its failure handler.
        onConstructed?.();
        if (!checked || value === input) return Effect.succeed(whole(value));
        const lost = unkept(given, value);
        if (lost.length === 0) return Effect.succeed(whole(value));
        // Give way only to a route that keeps everything; otherwise keep the constructor's loss.
        return Effect.catch(
          Effect.filterOrFail(
            accounted(input, given, parseOptions, onFieldwise),
            (read) => read.lost.length === 0,
          ),
          () => Effect.succeed({ value, lost }),
        );
      },
      onFailure: (failure) =>
        Effect.mapError(
          checked
            ? accounted(input, given, parseOptions, onFieldwise)
            : afterConstruction(input, given, parseOptions, onFieldwise),
          () => failure,
        ),
    }) as Effect.Effect<
      Decoded<S["Type"]>,
      Schema.SchemaError,
      S["DecodingServices"]
    >;
  };
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
 * union's input, so it is a part only where its union is, and shares its normalised input.
 */
const fromPart = (
  ast: SchemaAST.AST,
  value: unknown,
  reading: {
    /** Options for every parse. */
    readonly options: SchemaAST.ParseOptions | undefined;
    /** Whether the value is a part: a field, or a member of a part, whose losses are checked. */
    readonly part: boolean;
    /** The normalised input at this place, where the value is a part. */
    readonly given?: unknown;
    /** Told when the reading goes field by field. */
    readonly onFieldwise?: (() => void) | undefined;
  },
): Effect.Effect<Decoded<unknown>, Schema.SchemaError, unknown> =>
  decodedReading(Schema.make<Schema.Top>(ast), reading.options, reading.part)(
    value,
    undefined,
    reading.onFieldwise,
    reading.options,
    reading.given,
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
 * A value that cannot be read that way is read as Effect reads it, and the result is compared with
 * what went in, so what is lost is what actually went, not what a failure suggests would. The write
 * is strict first, because a loose write can choose another member and lose what the read kept.
 * The loose write notes which member wrote each value, and a field that member does not state is
 * lost, since its struct drops the field before anything else it does runs.
 *
 * The strict pass also gives a visible object or list a chance to win over Void in an any-of union.
 */
const readerForCodec = <S extends Schema.Top, A, R>(
  contract: S,
  codec: Schema.ConstraintCodec<S["Type"], A, unknown, R>,
  guarded: ReturnType<typeof guardVoidMembers>,
  custom?: Write<S, A, R>,
  canonicalJson = false,
) => {
  const write = custom ?? Schema.encodeEffect(codec);
  const decoded = toDecoded(contract);
  const ast = contract.ast;
  // The same positions, compared on the way in and on the way out of the schema.
  const readLoss = Excess.symbolLoss(ast, false);
  const writeLoss = Excess.symbolLoss(ast, canonicalJson);
  const losses = (input: unknown, value: unknown, output: unknown) =>
    Excess.uniquePaths([
      ...(readLoss?.(input, value) ?? []),
      ...(writeLoss?.(value, output) ?? []),
    ]);
  const written = (
    input: unknown,
    reading: ReturnType<typeof decoded>,
    options?: SchemaAST.ParseOptions,
  ) =>
    Effect.flatMap(reading, (value) =>
      Effect.map(write(value, options), (output): Written<A> => ({
        output,
        lost: losses(input, value, output),
      })),
    );
  if (guarded.ast === ast && !Excess.choosing(ast))
    return (input: Input<S>) => written(input, decoded(input));
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
              lost: losses(input, value, output),
            }),
          ),
          (failure) => ({
            failure,
            reading: false,
          }),
        ),
    );
  const withParts = decodedReading(contract);
  // The root's own checks run where its value is plain data and its schema names nothing every
  // object has; its parts are then each checked as they are.
  const plainRoot = !statesPrototypeName(ast, false);
  const readDecoded = (
    input: Input<S>,
    onConstructed?: () => void,
    onFieldwise?: () => void,
    given?: unknown,
  ) =>
    withParts(
      input,
      onConstructed,
      onFieldwise,
      undefined,
      plainRoot && isPlainData(input) ? given : undefined,
    );
  // A custom writer is the caller's own. Only the schema's own writer can note its members.
  const recordingAst =
    custom === undefined || strictWriter !== write
      ? recordingWriter(guardWrite)
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
  const compared = (
    input: Input<S>,
    given: unknown,
    read: (
      input: Input<S>,
      onConstructed: () => void,
      given: unknown,
    ) => Effect.Effect<
      Decoded<S["Type"]>,
      Schema.SchemaError,
      S["DecodingServices"]
    > = (current, onConstructed, normal) =>
      readDecoded(current, onConstructed, undefined, normal),
    onWriteFailure?: () => void,
    voidDeclined = false,
  ) =>
    Effect.suspend(() => {
      let constructed = false;
      return Effect.flatMap(
        read(
          input,
          () => {
            constructed = true;
          },
          given,
        ),
        ({ value, lost: lostByParts }) =>
          Effect.map(
            Effect.catch(
              Effect.map(
                strictWriter(value, Excess.strict),
                (output): Sent => ({ output }),
              ),
              (strict) => {
                onWriteFailure?.();
                // Relax excess-property handling while keeping any Void guard on the writer.
                return Effect.map(looseWrite(value), (loose): Sent => ({
                  ...loose,
                  strict,
                }));
              },
            ),
            ({ output, strict, writers }): Written<A> => {
              const choices =
                constructed && voidDeclined ? guarded.choices : undefined;
              // A field more than one comparison reports is named once.
              const lost = mergePaths(
                Excess.missing([ast], given, value, output, [], choices),
                losses(input, value, output),
                lostByParts,
              );
              const dropped =
                strict === undefined || writers === undefined
                  ? []
                  : droppedBy(
                      guardWrite,
                      { given, value, caller: input },
                      writers,
                    );
              if (dropped.length === 0) return { output, lost };
              const paths = dropped.map(({ path }) => path);
              const failure = writeFailure(ast, dropped);
              return {
                output,
                lost: mergePaths(lost, paths),
                ...(failure !== undefined && {
                  unwritten: { lost: paths, failure },
                }),
              };
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
          return compared(input, given, undefined, undefined, declined);
        return Effect.suspend(() => {
          let constructed = false;
          let fieldwise = false;
          let strictWrite = true;
          const read = (
            current: Input<S>,
            onConstructed: () => void,
            normal: unknown,
          ) =>
            readDecoded(
              current,
              () => {
                constructed = true;
                onConstructed();
              },
              () => {
                fieldwise = true;
              },
              normal,
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
  const remaining = [first, ...others] as const;
  // The member's failure stands in only if it names every field still uncovered; a field another
  // stacked schema took may be the one it names.
  const explains = (failure: Schema.SchemaError, written: Excess.Path[]) => {
    const writes = pathSet(written);
    const named = namedPaths(failure.issue);
    return remaining.every(
      (path) => writes.has(path) && named.some((other) => onPath(other, path)),
    );
  };
  return Effect.fail(
    unwritten !== undefined && explains(unwritten.failure, [...unwritten.lost])
      ? unwritten.failure
      : Excess.refusal(contract.ast, remaining),
  );
};

/** Bring a value to the schema's decoded side and write it, with nothing else to hold what it loses. */
export const encoder = <S extends Schema.Top, A, R>(
  contract: S,
  codec: Schema.ConstraintCodec<S["Type"], A, unknown, R>,
  canonicalJson = false,
) => {
  const guarded = guardVoidMembers(contract.ast);
  if (
    guarded.ast === contract.ast &&
    !Excess.choosing(contract.ast) &&
    Excess.symbolLoss(contract.ast, false) === undefined &&
    Excess.symbolLoss(contract.ast, canonicalJson) === undefined
  ) {
    const decoded = toDecoded(contract);
    const write = Schema.encodeEffect(codec);
    return (input: Input<S>) => Effect.flatMap(decoded(input), write);
  }
  const read = readerForCodec(
    contract,
    codec,
    guarded,
    undefined,
    canonicalJson,
  );
  return (
    input: Input<S>,
  ): Effect.Effect<A, Schema.SchemaError, R | S["DecodingServices"]> =>
    Effect.flatMap(read(input), ({ output, lost, unwritten }) =>
      Effect.as(refuseLost(contract, lost, undefined, unwritten), output),
    );
};
