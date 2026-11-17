import type { SchemaAST } from "effect";

const nonObjectTags: ReadonlySet<SchemaAST.AST["_tag"]> = new Set([
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Symbol",
  "UniqueSymbol",
  "Literal",
  "Enum",
  "TemplateLiteral",
  "Null",
  "Undefined",
  "Never",
]);

/** An actual ordinary or null-prototype object, or an actual array, as `Array.isArray` tells. */
type Cell = "record" | "array";

/**
 * Effect's array parser refuses whatever `Array.isArray` rejects. Its object parser refuses arrays
 * once it states a property or index signature; an empty struct reads any value but null/undefined.
 */
const stageRefuses = (ast: SchemaAST.AST, cell: Cell): boolean =>
  nonObjectTags.has(ast._tag) ||
  (cell === "record"
    ? ast._tag === "Arrays"
    : ast._tag === "Objects" &&
      (ast.propertySignatures.length > 0 || ast.indexSignatures.length > 0));

const refuses = (
  ast: SchemaAST.AST,
  cell: Cell,
  known: Map<SchemaAST.AST, boolean>,
): boolean => {
  const cached = known.get(ast);
  if (cached !== undefined) return cached;
  // Only a mutated AST forms a cycle. Seeding false declines it when it is reached again.
  known.set(ast, false);
  const result =
    (stageRefuses(ast, cell) ||
      (ast._tag === "Union" &&
        ast.types.every((member) => refuses(member, cell, known)))) &&
    // Effect reads an encoding's last `to` first. A plain transformation only maps that read's
    // success; middleware receives its failure and can recover, so any middleware link declines.
    (ast.encoding ?? []).every(
      ({ transformation, to }) =>
        transformation._tag === "Transformation" && refuses(to, cell, known),
    );
  known.set(ast, result);
  return result;
};

/**
 * Union members that cannot consume an actual ordinary or null-prototype object: primitives, arrays
 * and tuples. Void deliberately does not qualify.
 *
 * A union qualifies when every member does, so `Schema.Literals` and `Schema.NullOr(Schema.String)`
 * read like their flat members. An encoding qualifies when every link is a plain transformation and
 * every stage qualifies, as in `Schema.FiniteFromString`. Shared members are visited once.
 */
export const refusesRecord = (ast: SchemaAST.AST): boolean =>
  refuses(ast, "record", new Map());

/**
 * Union members that cannot consume an actual array: primitives and objects that state a property or
 * index signature, at every stage of a plain-transformation encoding.
 */
export const refusesArray = (ast: SchemaAST.AST): boolean =>
  refuses(ast, "array", new Map());

const isPrimitiveUnion = (
  ast: SchemaAST.Union,
  known: WeakMap<SchemaAST.AST, boolean>,
): boolean => {
  const cached = known.get(ast);
  if (cached !== undefined) return cached;
  // Only a mutated AST forms a union cycle. Seeding false declines it when it is reached again.
  known.set(ast, false);
  const result = ast.types.every(
    (member) =>
      member.encoding === undefined &&
      (nonObjectTags.has(member._tag) ||
        (member._tag === "Union" && isPrimitiveUnion(member, known))),
  );
  known.set(ast, result);
  return result;
};

/**
 * Unencoded union members that cannot consume an actual object; Void deliberately does not qualify.
 *
 * An unencoded union qualifies when every member does, so `Schema.Literals` and
 * `Schema.NullOr(Schema.String)` read like their flat members. Shared members are visited once.
 */
export const isNonObjectAlternative = (
  ast: SchemaAST.AST,
  known = new WeakMap<SchemaAST.AST, boolean>(),
): boolean =>
  ast.encoding === undefined &&
  (nonObjectTags.has(ast._tag) ||
    (ast._tag === "Union" && isPrimitiveUnion(ast, known)));
