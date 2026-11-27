import { Effect, Schema, SchemaAST, SchemaIssue, SchemaParser } from "effect";
import { candidates } from "./candidates.js";
import {
  choosesOpaqueOption,
  classFields,
  writtenOptionSource,
} from "./excess.js";
import { isPlainData, statesPrototypeName } from "./plain.js";
import { stageRefuses } from "./primitive.js";

/** A union a write went through, the member that wrote the value, and the first that could not. */
export interface WriterNote {
  readonly value: object;
  readonly union: SchemaAST.AST;
  readonly member: SchemaAST.AST;
  readonly before: SchemaIssue.Issue | undefined;
}

/** What one write noted, in the order its unions finished. */
export type WriterNotes = Array<WriterNote>;

// Effect 4.0.7 and 4.1.4 spread parse options, preserving this per-write record. Revisit the
// channel if a supported peer stops forwarding symbol keys.
const record = Symbol("record union writers");
// The options of the write around a union's strict attempt, for what that attempt has to write loosely.
const around = Symbol("options around a strict attempt");
// Set where a member is tried because it holds the whole value, so no union inside it may drop any.
const whole = Symbol("write the whole value");
// What the caller gave at the place of each object the write takes, where the two share names.
const suppliedBy = Symbol("what the caller supplied");
type RecordingOptions = SchemaAST.ParseOptions & {
  readonly [record]?: WriterNotes;
  readonly [around]?: RecordingOptions;
  readonly [whole]?: true;
  readonly [suppliedBy]?: Supplied;
};

/** The caller's plain value at the place an object of the written value sits, where it is known. */
type Supplied = (held: object) => Record<PropertyKey, unknown> | undefined;

/**
 * Pairs each object of the written value with the caller's value at the same place, following only
 * names the two share and plain data on both sides. An object met at two places pairs with neither.
 */
const pairing = ({ caller, given, value }: WriteInput): Supplied => {
  let pairs: WeakMap<object, Record<PropertyKey, unknown> | null> | undefined;
  const pair = (from: unknown, offered: unknown, held: unknown): void => {
    if (
      !isKeyed(from) ||
      !isKeyed(offered) ||
      !isKeyed(held) ||
      !isPlainData(from) ||
      !isPlainData(offered) ||
      !isPlainData(held)
    )
      return;
    if (pairs!.has(held)) {
      if (pairs!.get(held) !== offered) pairs!.set(held, null);
      return;
    }
    pairs!.set(held, offered);
    for (const key of Reflect.ownKeys(held))
      if (Object.hasOwn(offered, key)) pair(from[key], offered[key], held[key]);
  };
  return (held) => {
    if (pairs === undefined) {
      pairs = new WeakMap();
      pair(caller, given, value);
    }
    return pairs.get(held) ?? undefined;
  };
};

/**
 * Parse options that make a recording writer note each member that wrote a value. With what the
 * caller gave for it, a member tried only once its strict attempt failed for another reason may not
 * write under a name the caller used for a field the value no longer holds.
 */
export const recordingInto = (
  writers: WriterNotes,
  input?: WriteInput,
): RecordingOptions => ({
  [record]: writers,
  ...(input !== undefined && { [suppliedBy]: pairing(input) }),
});

/**
 * How a union member is tried: strictly, as the write's options say but with no union inside it
 * dropping a key, or as the write's options say.
 */
type Mode = "strict" | "whole" | "loose";

/** A union member to try, and how. */
interface Attempt {
  readonly index: number;
  readonly mode: Mode;
}

/** Members a union tries in turn, and which of them to try once the stages before have run. */
interface Stage {
  readonly attempts: ReadonlyArray<Attempt>;
  readonly admits: (attempt: Attempt) => boolean;
  /** Whether a write that {@link replaces} a field the caller gave is not taken here. */
  readonly refusesReplacing?: boolean;
  /** What the member that wrote here comes to, where it is not simply kept. */
  readonly settle?: (
    index: number,
  ) => Effect.Effect<unknown, SchemaIssue.Issue>;
  /** What two members writing here in a one-of union come to, where that union does not fail. */
  readonly twice?: (
    issue: SchemaIssue.OneOf,
  ) => Effect.Effect<unknown, SchemaIssue.Issue>;
}

/**
 * Whether a write puts a field under a name the caller gave where the value it wrote holds nothing
 * by that name, as a member that renames a default into the place of a field the reading did not
 * keep. Below the written value, places are followed by the names the value, the output and what
 * the caller gave share. Where what the caller gave is not known, any name the value does not hold
 * counts.
 */
const replaces = (
  value: unknown,
  output: unknown,
  given: Record<PropertyKey, unknown> | undefined,
): boolean =>
  isKeyed(value) &&
  isKeyed(output) &&
  isPlainData(value) &&
  isPlainData(output) &&
  Reflect.ownKeys(output).some((key) => {
    if (
      !Object.prototype.propertyIsEnumerable.call(output, key) ||
      output[key] === undefined
    )
      return false;
    if (!Object.hasOwn(value, key))
      return given === undefined || isSupplied(given, key);
    const below = givenBelow(given, key);
    return below !== null && replaces(value[key], output[key], below);
  });

const isSupplied = (given: Record<PropertyKey, unknown>, key: PropertyKey) =>
  Object.prototype.propertyIsEnumerable.call(given, key) &&
  given[key] !== undefined;

/**
 * What the caller gave below a key it gave as plain data, `null` where it gave nothing there by
 * name, and `undefined` where what it gave is not known.
 */
const givenBelow = (
  given: Record<PropertyKey, unknown> | undefined,
  key: PropertyKey,
): Record<PropertyKey, unknown> | null | undefined => {
  if (given === undefined) return undefined;
  const inner = isSupplied(given, key) ? given[key] : undefined;
  return isKeyed(inner) && isPlainData(inner) ? inner : null;
};

/** Whether a strict write's failure leaves room for a loose one, which would strip keys it names. */
const couldLoosen = (issue: SchemaIssue.Issue): boolean => {
  switch (issue._tag) {
    case "UnexpectedKey":
      return true;
    case "Pointer":
    case "Encoding":
    case "Filter":
      return couldLoosen(issue.issue);
    case "Composite":
      return issue.issues.every(couldLoosen);
    case "AnyOf":
      return issue.issues.some(couldLoosen);
    default:
      return false;
  }
};

/** A guarded Void declines an object or list. That says nothing about the value it was given. */
export const declinedByVoid = (issue: SchemaIssue.Issue): boolean =>
  issue._tag === "InvalidType" && issue.ast._tag === "Void";

type Parse = (
  input: unknown,
  options?: SchemaAST.ParseOptions,
) => Effect.Effect<unknown, SchemaIssue.Issue>;

// A declaration's parser is typed without services. The members' own services are already the
// writer's, which runs this declaration in the union's place.
const parser = (
  direction: "encode" | "decode",
  ast: SchemaAST.AST,
): (() => Parse) => {
  let parse: Parse | undefined;
  return () =>
    (parse ??= (
      direction === "encode"
        ? SchemaParser.encodeUnknownEffect
        : SchemaParser.decodeUnknownEffect
    )(Schema.make<Schema.Codec<unknown, unknown>>(ast)));
};

/**
 * A union that writes through a member that holds the whole value where one can, or else as Effect's
 * union does, and notes which member wrote each value.
 *
 * @remarks
 * The members to try are pre-selected as Effect selects them, so a member Effect would skip never
 * runs. Each in turn writes the value strictly or, where it states every key the value holds, as the
 * write's options say: what a strict write then refuses is the member's own, as a key its encoder
 * hands on or a field a class instance holds beside those it states. Only where no member can are
 * they tried as Effect tries them, those whose attempt failed only on keys it would strip.
 *
 * A step that reads the write's options can fail strictly for another reason, so that failure does
 * not show that the member cannot write as Effect writes it. Where the member written that way drops
 * a field the caller gave, the members that state every key the value holds are therefore tried as
 * the write's options say in its place, and where nothing writes, they are tried before the write
 * fails. A value a reading made, such as a constructor default, was not given, so a write dropping
 * only that is kept as it is, and nothing runs again. A member tried this way may not write a field
 * under a name the caller gave where the value holds nothing by that name, as a renamed member
 * writing a default in the place of a field the reading did not keep would. A member that drops a
 * field does not count against one that holds the value, as in the strict attempts; where two such
 * members write a one-of union's value, the write that dropped the field is kept, and what it drops
 * is refused for that ambiguity.
 *
 * A failed attempt forgets what was noted inside it, so only the members of the write that succeeded
 * remain. An any-of union keeps its first success; a one-of union fails if two members write in one
 * stage. The union's checks, encoding and context stay with it.
 */
const noting = (
  original: SchemaAST.Union,
  members: ReadonlyArray<SchemaAST.AST>,
  encoding: SchemaAST.Encoding | undefined,
): SchemaAST.AST => {
  // Effect encodes through the flipped union, and pre-selects members as encoding parses them.
  const flipped = original.types.map(SchemaAST.flip);
  const asParsed = new SchemaAST.Union(
    flipped,
    original.options,
    original.annotations,
    original.encodingChecks,
    undefined,
    original.context,
    original.checks,
  );
  let select: ((input: unknown) => ReadonlyArray<number>) | undefined;
  const encoders = members.map((member) => parser("encode", member));
  const decode = parser(
    "decode",
    new SchemaAST.Union(
      members,
      original.options,
      original.annotations,
      undefined,
      undefined,
      original.context,
    ),
  );
  const oneOf = original.options?.mode === "oneOf";
  return new SchemaAST.Declaration(
    [],
    () => (input, _self, options) => decode()(input, options),
    original.annotations,
    original.checks,
    encoding,
    original.context,
    original.encodingChecks,
    () => (input, _self, options: RecordingOptions) => {
      const writers = options[record];
      const order = (select ??= candidates(flipped))(input);
      const within = options.onExcessProperty === "error";
      const loose = options[around] ?? options;
      const parseOptions: Record<Mode, RecordingOptions> = {
        strict: within
          ? options
          : { ...options, onExcessProperty: "error", [around]: options },
        whole: { ...loose, [whole]: true },
        loose,
      };
      const forget = (mark: number) => {
        if (writers !== undefined) writers.length = mark;
      };
      const start = writers?.length ?? 0;
      /** What each member's last attempt failed with. */
      const issues = new Map<number, SchemaIssue.Issue>();
      /** The members whose strict attempt failed only on keys a looser attempt would strip. */
      const open = new Set<number>();
      /** The members that state every key the value holds. */
      const holders = new Set<number>();
      /** The members already tried as the write's options say. */
      const loosened = new Set<number>();
      const successes: Array<SchemaAST.AST> = [];
      let written:
        { readonly output: unknown; readonly index: number } | undefined;
      /** Where two members holding a one-of union's value wrote it in place of one that drops a field. */
      let ambiguous: SchemaIssue.OneOf | undefined;
      const finish = (): Effect.Effect<unknown, SchemaIssue.Issue> => {
        if (written === undefined)
          return Effect.fail(
            new SchemaIssue.AnyOf(
              asParsed,
              order.flatMap((index) => issues.get(index) ?? []),
              input,
              options,
            ),
          );
        const { index, output } = written;
        if (
          writers !== undefined &&
          typeof input === "object" &&
          input !== null
        )
          writers.push({
            value: input,
            union: original,
            member: original.types[index]!,
            before:
              ambiguous ??
              order
                .slice(0, order.indexOf(index))
                .flatMap((earlier) => issues.get(earlier) ?? [])
                .find((issue) => !declinedByVoid(issue)),
          });
        return Effect.succeed(output);
      };
      const strictly: Array<Attempt> = [];
      const holding: Array<Attempt> = [];
      const anyhow: Array<Attempt> = [];
      const held: Array<Attempt> = [];
      for (const index of order) {
        const member = original.types[index]!;
        anyhow.push({ index, mode: "loose" });
        // A Void writes any value strictly, so it may only follow the members that keep one.
        if (member._tag === "Void" && isKeyed(input)) {
          open.add(index);
          continue;
        }
        strictly.push({ index, mode: "strict" });
        if (statesEveryKey(member, input)) {
          holders.add(index);
          (oneOf ? holding : strictly).push({ index, mode: "whole" });
          held.push({ index, mode: "loose" });
        }
      }
      /** A whole or loose attempt follows a strict one that failed only on keys it would strip. */
      const reopened = ({ index, mode }: Attempt) =>
        mode === "strict" || open.delete(index);
      /** What the caller gave for this value, where it is known. */
      const given = () =>
        isKeyed(input) ? options[suppliedBy]?.(input) : undefined;
      /** Whether a member writing this value drops a field the caller gave. */
      const losesGiven = (index: number) =>
        !holders.has(index) &&
        dropsGiven(original.types[index]!, input, given());
      /** The members that hold the value and were not yet tried as the write's options say. */
      const holdersLeft: Stage = {
        attempts: held,
        admits: ({ index }) => !loosened.has(index),
        refusesReplacing: true,
      };
      /**
       * Try a stage's members in turn, then `after`: an any-of union after its first write, a one-of
       * union once every member has been tried. Two writes come to `twice`.
       */
      const tryStage = (
        current: Stage,
        after: () => Effect.Effect<unknown, SchemaIssue.Issue>,
        twice: (
          issue: SchemaIssue.OneOf,
        ) => Effect.Effect<unknown, SchemaIssue.Issue> = Effect.fail,
        position = 0,
      ): Effect.Effect<unknown, SchemaIssue.Issue> => {
        const next = current.attempts[position];
        if (next === undefined) return after();
        const following = () => tryStage(current, after, twice, position + 1);
        if (!current.admits(next)) return following();
        const { index, mode } = next;
        if (mode === "loose") loosened.add(index);
        const mark = writers?.length ?? 0;
        return Effect.matchEffect(
          encoders[index]!()(input, parseOptions[mode]),
          {
            onFailure: (issue) => {
              forget(mark);
              issues.set(index, issue);
              if (mode !== "loose" && couldLoosen(issue)) open.add(index);
              return following();
            },
            onSuccess: (output) => {
              // What such a member writes in the place of a field the caller gave is not theirs.
              if (
                current.refusesReplacing === true &&
                replaces(input, output, given())
              ) {
                forget(mark);
                return following();
              }
              successes.push(flipped[index]!);
              if (written === undefined) {
                written = { output, index };
                return oneOf ? following() : after();
              }
              forget(start);
              return twice(
                new SchemaIssue.OneOf(asParsed, [...successes], input, options),
              );
            },
          },
        );
      };
      /**
       * Where the member that wrote drops a field the caller gave, the members that hold the value
       * are tried in its place. Where none of them writes it, or two write a one-of union's value,
       * the write that was set aside comes to `otherwise`.
       */
      const instead = (
        otherwise: () => Effect.Effect<unknown, SchemaIssue.Issue>,
      ) => {
        const aside = {
          written,
          notes: writers?.splice(start) ?? [],
          successes: successes.splice(0),
        };
        written = undefined;
        const restore = () => {
          forget(start);
          writers?.push(...aside.notes);
          written = aside.written;
          successes.splice(0, successes.length, ...aside.successes);
          return otherwise();
        };
        return tryStage(
          holdersLeft,
          () => (written === undefined ? restore() : finish()),
          (issue) => {
            ambiguous = issue;
            return restore();
          },
        );
      };
      // Inside a strict or whole attempt nothing may be written loosely.
      const stages: ReadonlyArray<Stage> = [
        { attempts: strictly, admits: reopened },
        { attempts: holding, admits: reopened },
        ...(within || options[whole] === true
          ? []
          : [
              {
                attempts: anyhow,
                admits: reopened,
                settle: (index: number) =>
                  losesGiven(index) ? instead(finish) : finish(),
                twice: (issue: SchemaIssue.OneOf) =>
                  instead(() => Effect.fail(issue)),
              },
              // Before the write fails, every member that holds the value is tried.
              holdersLeft,
            ]),
      ];
      const run = (stage = 0): Effect.Effect<unknown, SchemaIssue.Issue> => {
        const current = stages[stage];
        if (current === undefined) return finish();
        return tryStage(
          current,
          () =>
            written === undefined
              ? run(stage + 1)
              : (current.settle?.(written.index) ?? finish()),
          current.twice,
        );
      };
      return run();
    },
  );
};

function mapSame<A>(
  items: readonly [A, ...A[]],
  map: (item: A, index: number) => A,
): readonly [A, ...A[]];
function mapSame<A>(
  items: readonly A[],
  map: (item: A, index: number) => A,
): readonly A[];
function mapSame<A>(
  items: readonly A[],
  map: (item: A, index: number) => A,
): readonly A[] {
  const mapped = items.map(map);
  return mapped.every((item, index) => item === items[index]) ? items : mapped;
}

/**
 * The writer with every visible union noting which member wrote each value.
 *
 * @remarks
 * Each union pre-selects and orders its members by the installed Effect's rules, so it writes what
 * the plain writer writes when it can keep the whole value. It follows suspensions when written,
 * classes into their structs, and unwrapping Option codecs into their payloads. A transformation or
 * middleware on a union itself makes Effect choose again on a transformed copy. That choice is
 * noted against the copy and remains the schema's own.
 */
export const recordingWriter = (root: SchemaAST.AST): SchemaAST.AST => {
  type Visit = (ast: SchemaAST.AST, source?: SchemaAST.AST) => SchemaAST.AST;
  const walker = (inPayload: boolean): Visit => {
    const cache = new WeakMap<SchemaAST.AST, SchemaAST.AST>();
    const projections = new WeakMap<
      SchemaAST.AST,
      WeakMap<SchemaAST.AST, SchemaAST.AST>
    >();
    const visit = (ast: SchemaAST.AST, source = ast): SchemaAST.AST => {
      if (source === ast) {
        const cached = cache.get(ast);
        if (cached !== undefined) return cached;
        const result = rewrite(ast, source, visit, inPayload);
        cache.set(ast, result);
        return result;
      }
      let projected = projections.get(source);
      if (projected === undefined) {
        projected = new WeakMap();
        projections.set(source, projected);
      }
      const cached = projected.get(ast);
      if (cached !== undefined) return cached;
      const result = rewrite(ast, source, visit, inPayload);
      projected.set(ast, result);
      return result;
    };
    return visit;
  };
  // Effect parses a Some against the decoded projection before unwrapping it. Carry the
  // source through that projection so a nested unwrapping codec keeps its provenance.
  // A plain Schema.Option encountered along either path remains an opaque declaration.
  const rewrite = (
    ast: SchemaAST.AST,
    source: SchemaAST.AST,
    visit: Visit,
    inPayload: boolean,
  ): SchemaAST.AST => {
    // A synthetic strict attempt would change which member Effect writes inside a tagged Option.
    if (inPayload && source._tag === "Union" && choosesOpaqueOption(source))
      return ast;
    if (ast._tag === "Suspend") {
      // Follow a suspended schema only when it is written, so a recursive one stays finite.
      let target: SchemaAST.AST | undefined;
      return new SchemaAST.Suspend(
        () =>
          (target ??= visit(
            ast.thunk(),
            source !== ast && source._tag === "Suspend"
              ? source.thunk()
              : undefined,
          )),
        ast.annotations,
        undefined,
        ast.encoding,
        ast.context,
      );
    }
    const payload =
      source._tag === "Declaration" ? writtenOptionSource(source) : undefined;
    if (
      ast._tag !== "Objects" &&
      ast._tag !== "Arrays" &&
      ast._tag !== "Union" &&
      classFields(ast) === undefined &&
      payload === undefined
    )
      return ast;
    const encoding =
      ast.encoding &&
      mapSame(ast.encoding, (link) => {
        const target = (payload === undefined ? visit : visitPayload)(link.to);
        return target === link.to
          ? link
          : new SchemaAST.Link(target, link.transformation);
      });
    if (ast._tag === "Declaration") {
      // Effect parses the native Some's payload before applying the codec's encoding links.
      const typeParameters =
        payload === undefined
          ? ast.typeParameters
          : mapSame(ast.typeParameters, (parameter) =>
              visitPayload(parameter, payload),
            );
      return encoding === ast.encoding && typeParameters === ast.typeParameters
        ? ast
        : new SchemaAST.Declaration(
            typeParameters,
            ast.run,
            ast.annotations,
            ast.checks,
            encoding,
            ast.context,
            ast.encodingChecks,
            ast.encodingRun,
          );
    }
    if (ast._tag === "Objects") {
      const properties = mapSame(ast.propertySignatures, (property, index) => {
        const type = visit(
          property.type,
          source._tag === "Objects"
            ? source.propertySignatures[index]?.type
            : undefined,
        );
        return type === property.type
          ? property
          : new SchemaAST.PropertySignature(property.name, type);
      });
      const indexes = mapSame(ast.indexSignatures, (index, position) => {
        const type = visit(
          index.type,
          source._tag === "Objects"
            ? source.indexSignatures[position]?.type
            : undefined,
        );
        return type === index.type
          ? index
          : new SchemaAST.IndexSignature(index.parameter, type);
      });
      return encoding === ast.encoding &&
        properties === ast.propertySignatures &&
        indexes === ast.indexSignatures
        ? ast
        : new SchemaAST.Objects(
            properties,
            indexes,
            ast.annotations,
            ast.checks,
            encoding,
            ast.context,
            ast.encodingChecks,
          );
    }
    if (ast._tag === "Arrays") {
      const elements = mapSame(ast.elements, (element, index) =>
        visit(
          element,
          source._tag === "Arrays" ? source.elements[index] : undefined,
        ),
      );
      const rest = mapSame(ast.rest, (element, index) =>
        visit(
          element,
          source._tag === "Arrays" ? source.rest[index] : undefined,
        ),
      );
      return encoding === ast.encoding &&
        elements === ast.elements &&
        rest === ast.rest
        ? ast
        : new SchemaAST.Arrays(
            ast.isMutable,
            elements,
            rest,
            ast.annotations,
            ast.checks,
            encoding,
            ast.context,
            ast.encodingChecks,
          );
    }
    return ast._tag === "Union"
      ? noting(
          ast,
          ast.types.map((member, index) =>
            visit(
              member,
              source._tag === "Union" ? source.types[index] : undefined,
            ),
          ),
          encoding,
        )
      : ast;
  };
  const visitPayload = walker(true);
  return walker(false)(root);
};

/** Any object or list, whose keys can be read. */
export const isKeyed = (
  value: unknown,
): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

/** Whether an index signature's parameter takes a key, as Effect selects a record's keys. */
const takes = (parameter: SchemaAST.AST, key: PropertyKey): boolean => {
  switch (parameter._tag) {
    case "String":
      return (
        typeof key === "string" &&
        (parameter.checks === undefined ||
          Schema.is(Schema.make<Schema.Top>(parameter))(key))
      );
    case "TemplateLiteral":
      return (
        typeof key === "string" &&
        Schema.is(Schema.make<Schema.Top>(parameter))(key)
      );
    case "Number":
      return (
        typeof key === "string" &&
        String(Number(key)) === key &&
        Schema.is(Schema.make<Schema.Top>(parameter))(Number(key))
      );
    case "Symbol":
    case "UniqueSymbol":
      return (
        typeof key === "symbol" &&
        Schema.is(Schema.make<Schema.Top>(parameter))(key)
      );
    case "Union":
      return parameter.types.some((type) => takes(type, key));
    default:
      return false;
  }
};

/** A struct's fields by name, read once for each struct the walk meets. */
const fieldTypesBy = new WeakMap<
  SchemaAST.Objects,
  ReadonlyMap<PropertyKey, SchemaAST.AST>
>();

const fieldTypesOf = (ast: SchemaAST.Objects) => {
  let fields = fieldTypesBy.get(ast);
  if (fields === undefined)
    fieldTypesBy.set(
      ast,
      (fields = new Map(
        ast.propertySignatures.map(({ name, type }) => [name, type]),
      )),
    );
  return fields;
};

/**
 * The schemas a struct writes a key with: its field of that name and the signatures that take it,
 * or undefined where it drops the key. A struct that states no key keeps them all.
 */
const writtenWith = (
  ast: SchemaAST.Objects,
  key: PropertyKey,
): ReadonlyArray<SchemaAST.AST> | undefined => {
  const field = fieldTypesOf(ast).get(key);
  if (ast.indexSignatures.length === 0)
    return field !== undefined
      ? [field]
      : ast.propertySignatures.length === 0
        ? []
        : undefined;
  const types = ast.indexSignatures
    .filter(({ parameter }) => takes(parameter, key))
    .map(({ type }) => type);
  if (field !== undefined) types.unshift(field);
  return types.length > 0 ? types : undefined;
};

/** The schema of an item. Positions after a rest element read from its trailing elements. */
const itemType = (
  ast: SchemaAST.Arrays,
  index: number,
  length: number,
): SchemaAST.AST | undefined => {
  if (index < ast.elements.length) return ast.elements[index];
  // The trailing elements are counted from the end.
  const tail = Math.max(
    ast.elements.length,
    length - Math.max(0, ast.rest.length - 1),
  );
  return index >= tail ? ast.rest[index - tail + 1] : ast.rest[0];
};

/** Whether a schema states every key a value holds, at each place whose structure it shows. */
const statesEveryKey = (ast: SchemaAST.AST, value: unknown): boolean => {
  if (!isKeyed(value)) return true;
  if (ast._tag === "Suspend") return statesEveryKey(ast.thunk(), value);
  if (ast._tag === "Union")
    return ast.types.some((member) => statesEveryKey(member, value));
  // Text, or a list where the value is an object, takes no such value at all.
  if (stageRefuses(ast, Array.isArray(value) ? "array" : "record"))
    return false;
  if (ast._tag === "Objects")
    return Reflect.ownKeys(value).every(
      (key) =>
        !Object.prototype.propertyIsEnumerable.call(value, key) ||
        value[key] === undefined ||
        writtenWith(ast, key)?.every((type) =>
          statesEveryKey(type, value[key]),
        ) === true,
    );
  if (ast._tag === "Arrays" && Array.isArray(value))
    return value.every((item, index) => {
      const type = itemType(ast, index, value.length);
      return type === undefined || statesEveryKey(type, item);
    });
  return true;
};

/**
 * Whether a schema would strip a field the caller supplied: a key the value holds that the schema
 * does not state, at a place whose structure it shows, as {@link statesEveryKey} reads it, that the
 * caller gave under the same name there. A value a reading made, such as a constructor default, was
 * not supplied. Where what the caller gave is not known, any such key counts: Effect writes a union
 * below a renamed struct again, from what its first write wrote, and what that second write drops is
 * not accounted for.
 */
const dropsGiven = (
  ast: SchemaAST.AST,
  value: unknown,
  given: Record<PropertyKey, unknown> | undefined,
): boolean => {
  if (!isKeyed(value)) return false;
  if (ast._tag === "Suspend") return dropsGiven(ast.thunk(), value, given);
  if (ast._tag === "Union")
    return ast.types.every((member) => dropsGiven(member, value, given));
  if (stageRefuses(ast, Array.isArray(value) ? "array" : "record"))
    return false;
  const inside = (
    types: ReadonlyArray<SchemaAST.AST>,
    key: PropertyKey,
    item: unknown,
  ) => {
    const below = givenBelow(given, key);
    return (
      below !== null && types.some((type) => dropsGiven(type, item, below))
    );
  };
  if (ast._tag === "Objects")
    return Reflect.ownKeys(value).some((key) => {
      if (
        !Object.prototype.propertyIsEnumerable.call(value, key) ||
        value[key] === undefined
      )
        return false;
      const types = writtenWith(ast, key);
      return types === undefined
        ? given === undefined || isSupplied(given, key)
        : inside(types, key, value[key]);
    });
  if (ast._tag === "Arrays" && Array.isArray(value))
    return value.some((item, index) => {
      const type = itemType(ast, index, value.length);
      return type !== undefined && inside([type], index, item);
    });
  return false;
};

/** A supplied field a write dropped, and the union whose chosen member dropped it. */
export interface Dropped {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly union: ReadonlyArray<PropertyKey> | undefined;
  readonly before: SchemaIssue.Issue | undefined;
}

/** What a write was given, as the caller gave it and normalised, and the value it wrote. */
export interface WriteInput {
  /** The caller's value, which says where it is plain data. */
  readonly caller: unknown;
  /** The caller's value as the schema normalised it. */
  readonly given: unknown;
  /** The decoded value the write took. */
  readonly value: unknown;
}

/**
 * The supplied fields a relaxed write dropped.
 *
 * @remarks
 * A struct's type side reads only the names it states, so every struct the write goes through drops
 * the other keys of the value before any of its own steps run. A struct that states no key keeps
 * them all. A key counts when the caller supplied it and the decoded value holds it under the same
 * name; one a decoder made is in neither. Each union is followed into the member that wrote the
 * value at that place, as the write noted it. A class or other declaration, and a union no member of
 * which wrote there, is the schema's own reading.
 *
 * The walk goes only where the caller's value is plain data, held as own data properties, and the
 * schema there names nothing every object has. Elsewhere the write is Effect's own. Only the
 * structure the writer states is followed, so nothing inside an opaque value is read.
 */
export const dropped = (
  writer: SchemaAST.AST,
  { caller: root, given, value }: WriteInput,
  written: WriterNotes,
): ReadonlyArray<Dropped> => {
  if (written.length === 0) return [];
  const writers = new WeakMap<object, Map<SchemaAST.AST, WriterNote>>();
  for (const entry of written) {
    let at = writers.get(entry.value);
    if (at === undefined) writers.set(entry.value, (at = new Map()));
    if (!at.has(entry.union)) at.set(entry.union, entry);
  }
  const lost: Array<Dropped> = [];
  interface Choice {
    readonly path: ReadonlyArray<PropertyKey>;
    readonly before: SchemaIssue.Issue | undefined;
  }
  const visit = (
    ast: SchemaAST.AST,
    supplied: unknown,
    held: unknown,
    caller: unknown,
    path: ReadonlyArray<PropertyKey>,
    choice: Choice | undefined,
  ): void => {
    if (
      !isKeyed(supplied) ||
      !isKeyed(held) ||
      !isKeyed(caller) ||
      !isPlainData(caller) ||
      statesPrototypeName(ast)
    )
      return;
    let node: SchemaAST.AST | undefined = ast;
    let chosen = choice;
    while (node?._tag === "Suspend" || node?._tag === "Union") {
      if (node._tag === "Suspend") {
        node = node.thunk();
        continue;
      }
      const entry: WriterNote | undefined = writers.get(held)?.get(node);
      if (entry === undefined) return;
      chosen = { path, before: entry.before };
      node = entry.member;
    }
    // A class writes the fields it holds through the struct it states them in.
    node = (node && classFields(node)) ?? node;
    if (node?._tag === "Objects") {
      for (const key of Reflect.ownKeys(supplied)) {
        if (
          !Object.prototype.propertyIsEnumerable.call(supplied, key) ||
          supplied[key] === undefined ||
          !(key in held) ||
          held[key] === undefined
        )
          continue;
        const types = writtenWith(node, key);
        if (types === undefined)
          lost.push({
            path: [...path, key],
            union: chosen?.path,
            before: chosen?.before,
          });
        else if (isKeyed(supplied[key]) && isKeyed(held[key])) {
          // Plain data holds every field as its own data, so reading it runs no accessor. A proxy's
          // traps run, as they do throughout preparation.
          const at = [...path, key];
          for (const type of types)
            visit(type, supplied[key], held[key], caller[key], at, chosen);
        }
      }
      return;
    }
    if (
      node?._tag === "Arrays" &&
      Array.isArray(supplied) &&
      Array.isArray(held)
    ) {
      for (let index = 0; index < supplied.length; index++) {
        const type = itemType(node, index, held.length);
        if (type !== undefined && Object.hasOwn(supplied, index))
          visit(
            type,
            supplied[index],
            held[index],
            caller[index],
            [...path, index],
            chosen,
          );
      }
    }
  };
  visit(writer, given, value, root, [], undefined);
  return lost;
};
