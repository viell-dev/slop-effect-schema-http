import { Effect, Schema, SchemaAST, SchemaIssue, SchemaParser } from "effect";
import { candidates } from "./candidates.js";
import { classFields } from "./excess.js";
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
type RecordingOptions = SchemaAST.ParseOptions & {
  readonly [record]?: WriterNotes;
  readonly [around]?: RecordingOptions;
};

/** Parse options that make a recording writer note each member that wrote a value. */
export const recordingInto = (
  writers: WriterNotes,
  options?: SchemaAST.ParseOptions,
): RecordingOptions => ({ ...options, [record]: writers });

/** A union member to try, strictly or as the write's options say. */
interface Attempt {
  readonly index: number;
  readonly strictly: boolean;
}

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
 * they tried as Effect tries them. A failed attempt forgets what was noted inside it, so only the
 * members of the write that succeeded remain. An any-of union keeps its first success; a one-of union
 * fails if two members write. The union's checks, encoding and context stay with it.
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
      const strict: RecordingOptions = within
        ? options
        : { ...options, onExcessProperty: "error", [around]: options };
      const forget = (mark: number) => {
        if (writers !== undefined) writers.length = mark;
      };
      const start = writers?.length ?? 0;
      /** What each member's last attempt failed with. */
      const issues = new Map<number, SchemaIssue.Issue>();
      /** The members a looser attempt could still write through. */
      const open = new Set<number>();
      const successes: Array<SchemaAST.AST> = [];
      let written:
        { readonly output: unknown; readonly index: number } | undefined;
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
            before: order
              .slice(0, order.indexOf(index))
              .flatMap((earlier) => issues.get(earlier) ?? [])
              .find((issue) => !declinedByVoid(issue)),
          });
        return Effect.succeed(output);
      };
      const attempt = (
        stages: ReadonlyArray<ReadonlyArray<Attempt>>,
        stage = 0,
        position = 0,
      ): Effect.Effect<unknown, SchemaIssue.Issue> => {
        const attempts = stages[stage];
        if (attempts === undefined) return finish();
        const current = attempts[position];
        if (current === undefined)
          return written === undefined ? attempt(stages, stage + 1) : finish();
        const { index, strictly } = current;
        const next = () => attempt(stages, stage, position + 1);
        if (!strictly && !open.delete(index)) return next();
        const mark = writers?.length ?? 0;
        return Effect.matchEffect(
          encoders[index]!()(input, strictly ? strict : loose),
          {
            onFailure: (issue) => {
              forget(mark);
              issues.set(index, issue);
              if (strictly && couldLoosen(issue)) open.add(index);
              return next();
            },
            onSuccess: (output) => {
              successes.push(flipped[index]!);
              if (written !== undefined) {
                forget(start);
                return Effect.fail(
                  new SchemaIssue.OneOf(asParsed, successes, input, options),
                );
              }
              written = { output, index };
              return oneOf ? next() : finish();
            },
          },
        );
      };
      const strictly: Array<Attempt> = [];
      const holding: Array<Attempt> = [];
      const anyhow: Array<Attempt> = [];
      for (const index of order) {
        const member = original.types[index]!;
        anyhow.push({ index, strictly: false });
        // A Void writes any value strictly, so it may only follow the members that keep one.
        if (member._tag === "Void" && isKeyed(input)) {
          open.add(index);
          continue;
        }
        strictly.push({ index, strictly: true });
        if (statesEveryKey(member, input))
          (oneOf ? holding : strictly).push({ index, strictly: false });
      }
      return attempt([strictly, holding, ...(within ? [] : [anyhow])]);
    },
  );
};

function mapSame<A>(
  items: readonly [A, ...A[]],
  map: (item: A) => A,
): readonly [A, ...A[]];
function mapSame<A>(items: readonly A[], map: (item: A) => A): readonly A[];
function mapSame<A>(items: readonly A[], map: (item: A) => A): readonly A[] {
  const mapped = items.map(map);
  return mapped.every((item, index) => item === items[index]) ? items : mapped;
}

/**
 * The writer with every visible union noting which member wrote each value.
 *
 * @remarks
 * Each union pre-selects and orders its members by the installed Effect's rules, so it writes what
 * the plain writer writes and runs the same member code. It follows a suspended schema when it is
 * written, and a class into the struct it writes, and stays out of other declarations. A transformation or middleware on a
 * union itself makes Effect choose again on a transformed copy, which no caller field can be traced
 * to; that choice is noted against the copy and so remains the schema's own.
 */
export const recordingWriter = (root: SchemaAST.AST): SchemaAST.AST => {
  const cache = new WeakMap<SchemaAST.AST, SchemaAST.AST>();
  const visit = (ast: SchemaAST.AST): SchemaAST.AST => {
    const cached = cache.get(ast);
    if (cached !== undefined) return cached;
    const result = rewrite(ast);
    cache.set(ast, result);
    return result;
  };
  const rewrite = (ast: SchemaAST.AST): SchemaAST.AST => {
    if (ast._tag === "Suspend") {
      // Follow a suspended schema only when it is written, so a recursive one stays finite.
      let target: SchemaAST.AST | undefined;
      return new SchemaAST.Suspend(
        () => (target ??= visit(ast.thunk())),
        ast.annotations,
        undefined,
        ast.encoding,
        ast.context,
      );
    }
    if (
      ast._tag !== "Objects" &&
      ast._tag !== "Arrays" &&
      ast._tag !== "Union" &&
      classFields(ast) === undefined
    )
      return ast;
    const encoding =
      ast.encoding &&
      mapSame(ast.encoding, (link) => {
        const target = visit(link.to);
        return target === link.to
          ? link
          : new SchemaAST.Link(target, link.transformation);
      });
    if (ast._tag === "Declaration")
      return encoding === ast.encoding
        ? ast
        : new SchemaAST.Declaration(
            ast.typeParameters,
            ast.run,
            ast.annotations,
            ast.checks,
            encoding,
            ast.context,
            ast.encodingChecks,
            ast.encodingRun,
          );
    if (ast._tag === "Objects") {
      const properties = mapSame(ast.propertySignatures, (property) => {
        const type = visit(property.type);
        return type === property.type
          ? property
          : new SchemaAST.PropertySignature(property.name, type);
      });
      const indexes = mapSame(ast.indexSignatures, (index) => {
        const type = visit(index.type);
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
      const elements = mapSame(ast.elements, visit);
      const rest = mapSame(ast.rest, visit);
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
      ? noting(ast, ast.types.map(visit), encoding)
      : ast;
  };
  return visit(root);
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
