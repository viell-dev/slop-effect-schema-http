import {
  Effect,
  Schema,
  SchemaAST,
  type SchemaIssue,
  SchemaParser,
} from "effect";

/** Which union member wrote each value, in the order the writes finished. */
export type Writers = Array<readonly [object, SchemaAST.AST]>;

// Effect 4.0.7 and 4.1.4 spread parse options, preserving this per-write record. Revisit the
// channel if a supported peer stops forwarding symbol keys.
const record = Symbol("record union writers");
type RecordingOptions = SchemaAST.ParseOptions & {
  readonly [record]?: Writers;
};

/** Parse options that make a recording writer note each member that wrote a value. */
export const recordingInto = (
  writers: Writers,
  options?: SchemaAST.ParseOptions,
): RecordingOptions => ({ ...options, [record]: writers });

/**
 * A union member that notes the value it wrote. A failed attempt forgets what members inside it
 * noted, so after a successful write only the members of that write remain.
 */
const noting = (member: SchemaAST.AST): SchemaAST.AST => {
  // A declaration's parser is typed without services. The member's own services are already the
  // writer's, which runs this declaration in its place.
  const schema = Schema.make<Schema.Codec<unknown, unknown>>(member);
  type Parse = (
    input: unknown,
    options?: SchemaAST.ParseOptions,
  ) => Effect.Effect<unknown, SchemaIssue.Issue>;
  let encode: Parse | undefined;
  let decode: Parse | undefined;
  return new SchemaAST.Declaration(
    [],
    () => (input, _self, options) =>
      (decode ??= SchemaParser.decodeUnknownEffect(schema))(input, options),
    member.annotations,
    undefined,
    undefined,
    member.context,
    undefined,
    () => (input, _self, options: RecordingOptions) => {
      const writers = options[record];
      const mark = writers?.length ?? 0;
      return Effect.matchEffect(
        (encode ??= SchemaParser.encodeUnknownEffect(schema))(input, options),
        {
          onFailure: (issue) => {
            if (writers !== undefined) writers.length = mark;
            return Effect.fail(issue);
          },
          onSuccess: (output) => {
            if (
              writers !== undefined &&
              typeof input === "object" &&
              input !== null
            )
              writers.push([input, member]);
            return Effect.succeed(output);
          },
        },
      );
    },
  );
};

/** Whether an index signature's parameter takes a key, where its kind of key is plain to see. */
const takes = (parameter: SchemaAST.AST, key: PropertyKey): boolean => {
  switch (parameter._tag) {
    case "String":
    case "TemplateLiteral":
    case "Number":
      return typeof key === "string";
    case "Symbol":
    case "UniqueSymbol":
      return typeof key === "symbol";
    default:
      return true;
  }
};

/** The schemas a struct reads under a key: its field of that name and the signatures that take it. */
const typesAt = (
  ast: SchemaAST.Objects,
  key: PropertyKey,
): ReadonlyArray<SchemaAST.AST> => [
  ...ast.propertySignatures
    .filter(({ name }) => name === key)
    .map(({ type }) => type),
  ...ast.indexSignatures
    .filter(({ parameter }) => takes(parameter, key))
    .map(({ type }) => type),
];

const isObject = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

/**
 * The supplied fields that the members a relaxed write chose did not take.
 *
 * @remarks
 * A struct's type side reads only the names it states, so a member a union chose drops every other
 * key of the value it wrote before any of its own steps runs. A key counts when the caller supplied
 * it and the decoded value holds it under the same name. A member that is not a struct, such as a
 * class or other declaration, is the schema's own reading. Only the structure the writer states is
 * followed, so nothing inside an opaque value is read.
 */
export const dropped = (
  writer: SchemaAST.AST,
  given: unknown,
  value: unknown,
  written: Writers,
): ReadonlyArray<ReadonlyArray<PropertyKey>> => {
  if (written.length === 0) return [];
  const writers = new WeakMap<object, SchemaAST.AST>();
  for (const [wrote, member] of written)
    if (!writers.has(wrote)) writers.set(wrote, member);
  const lost: Array<ReadonlyArray<PropertyKey>> = [];
  const visit = (
    ast: SchemaAST.AST,
    supplied: unknown,
    held: unknown,
    path: ReadonlyArray<PropertyKey>,
  ): void => {
    if (!isObject(supplied) || !isObject(held) || supplied === held) return;
    if (ast._tag === "Suspend") return visit(ast.thunk(), supplied, held, path);
    const chosen = ast._tag === "Union" ? writers.get(held) : undefined;
    const node = ast._tag === "Union" ? chosen : ast;
    if (node?._tag === "Objects") {
      for (const key of Reflect.ownKeys(supplied)) {
        if (
          !Object.prototype.propertyIsEnumerable.call(supplied, key) ||
          supplied[key] === undefined ||
          !(key in held) ||
          held[key] === undefined
        )
          continue;
        const types = typesAt(node, key);
        if (chosen !== undefined && types.length === 0)
          lost.push([...path, key]);
        else
          for (const type of types)
            visit(type, supplied[key], held[key], [...path, key]);
      }
      return;
    }
    if (
      node?._tag === "Arrays" &&
      Array.isArray(supplied) &&
      Array.isArray(held)
    )
      for (let index = 0; index < supplied.length; index++) {
        const type = node.elements[index] ?? node.rest[0];
        if (type !== undefined && Object.hasOwn(supplied, index))
          visit(type, supplied[index], held[index], [...path, index]);
      }
  };
  visit(writer, given, value, []);
  return lost;
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
 * The writer with each member of every visible union noting what it wrote, so a relaxed write can
 * name the member that actually wrote each value.
 *
 * @remarks
 * Effect tries a union's members in order and keeps the first that writes, so the recording writer
 * writes exactly what the plain one does. It follows a suspended schema when it is written, and
 * stays out of declarations, as the Void guard does. A transformation or middleware on a union
 * itself makes Effect choose again on a transformed copy, which no caller field can be traced to,
 * so that choice is the schema's own. A wrapped member is a declaration, which Effect does not
 * pre-select by tag, so a member whose tag does not match can start its own write before it fails;
 * Effect 4.0.7 does not export the selection to repeat it.
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
    if (ast._tag !== "Objects" && ast._tag !== "Arrays" && ast._tag !== "Union")
      return ast;
    const encoding =
      ast.encoding &&
      mapSame(ast.encoding, (link) => {
        const target = visit(link.to);
        return target === link.to
          ? link
          : new SchemaAST.Link(target, link.transformation);
      });
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
    // A member union notes nothing itself: its own members note the value they wrote.
    const members = mapSame(ast.types, (member) => {
      const inner = visit(member);
      return member._tag === "Union" ? inner : noting(inner);
    });
    return new SchemaAST.Union(
      members,
      ast.options,
      ast.annotations,
      ast.checks,
      encoding,
      ast.context,
      ast.encodingChecks,
    );
  };
  return visit(root);
};
