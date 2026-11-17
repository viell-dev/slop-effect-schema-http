import { Effect, Schema, SchemaAST, SchemaIssue } from "effect";

const preserve = Symbol("preserve caller fields against Void");
type PreserveOptions = SchemaAST.ParseOptions & {
  readonly [preserve]?: {
    readonly refuses: (input: unknown) => boolean;
    readonly follow?: (input: unknown, read: unknown) => void;
  };
};

const preserving = (
  options: SchemaAST.ParseOptions,
  scope: NonNullable<PreserveOptions[typeof preserve]>,
): PreserveOptions => ({ ...options, [preserve]: scope });

const isObject = (value: unknown): value is object =>
  typeof value === "object" && value !== null;

export const preservingRead = (
  options: SchemaAST.ParseOptions,
  given: WeakSet<object>,
  declined: WeakSet<object>,
) =>
  preserving(options, {
    refuses: (input) => {
      if (!isObject(input) || !given.has(input)) return false;
      declined.add(input);
      return true;
    },
    follow: (input, read) => {
      if (isObject(input) && given.has(input) && isObject(read))
        given.add(read);
    },
  });

export const preservingWrite = (options: SchemaAST.ParseOptions) =>
  preserving(options, { refuses: isObject });

/** Fieldwise construction replaces a supplied object with the object its field schema read. */
export const followRead = (
  options: PreserveOptions | undefined,
  input: unknown,
  read: unknown,
) => options?.[preserve]?.follow?.(input, read);

const discarded = new SchemaIssue.InvalidValue({
  message: "Void would discard this value",
});
const empty = Effect.succeed(undefined);
const reject = Effect.fail(discarded);
const jsonVoid = Schema.toCodecJson(Schema.Void).ast.encoding;

const isPlainVoid = (ast: SchemaAST.AST, json: boolean) =>
  ast._tag === "Void" &&
  (ast.encoding === undefined || (json && ast.encoding === jsonVoid));

const objectMember = (ast: SchemaAST.AST): boolean =>
  ast._tag === "Objects" ||
  ast._tag === "Arrays" ||
  ast._tag === "Any" ||
  ast._tag === "Unknown" ||
  ast._tag === "ObjectKeyword" ||
  (ast._tag === "Union" && ast.types.some(objectMember));

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
 * Keep the union and its other members intact. The strict parser can decline the built-in Void
 * member before it erases the value. Its ordinary behavior (including missing and JSON null)
 * is represented by the same context and encoding links.
 */
export const guardVoidMembers = (root: SchemaAST.AST, json: boolean) => {
  const cache = new WeakMap<SchemaAST.AST, SchemaAST.AST>();
  const visit = (ast: SchemaAST.AST): SchemaAST.AST => {
    const cached = cache.get(ast);
    if (cached !== undefined) return cached;
    const result = rewrite(ast);
    cache.set(ast, result);
    return result;
  };
  const rewrite = (ast: SchemaAST.AST): SchemaAST.AST => {
    // Stay out of opaque declarations and suspensions. Keep all original link transformations.
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
    const protect =
      (ast.options?.mode ?? "anyOf") === "anyOf" &&
      ast.types.some(objectMember);
    const members = mapSame(ast.types, (member) =>
      protect && isPlainVoid(member, json)
        ? new SchemaAST.Declaration(
            [],
            () => (input, _self, options: PreserveOptions) =>
              options[preserve]?.refuses(input) ? reject : empty,
            member.annotations,
            member.checks,
            member.encoding,
            member.context,
          )
        : visit(member),
    );
    return encoding === ast.encoding && members === ast.types
      ? ast
      : new SchemaAST.Union(
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
