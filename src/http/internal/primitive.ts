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
export type Cell = "record" | "array";

/**
 * Effect's array parser refuses whatever `Array.isArray` rejects. Its object parser refuses arrays
 * once it states a property or index signature; an empty struct reads any value but null/undefined.
 * This judges one node alone, before any encoding, and holds for any object that is not an array,
 * a class instance included.
 */
export const stageRefuses = (ast: SchemaAST.AST, cell: Cell): boolean =>
  nonObjectTags.has(ast._tag) ||
  (cell === "record"
    ? ast._tag === "Arrays"
    : ast._tag === "Objects" &&
      (ast.propertySignatures.length > 0 || ast.indexSignatures.length > 0));

const objectMembers = new WeakMap<SchemaAST.AST, boolean>();

/**
 * Whether a union member can read an object or a list: the members beside which the Void rule
 * guards a Void. A union is one when any of its members is.
 */
export const isObjectMember = (ast: SchemaAST.AST): boolean => {
  const cached = objectMembers.get(ast);
  if (cached !== undefined) return cached;
  const result =
    ast._tag === "Objects" ||
    ast._tag === "Arrays" ||
    ast._tag === "Any" ||
    ast._tag === "Unknown" ||
    ast._tag === "ObjectKeyword" ||
    (ast._tag === "Union" && ast.types.some(isObjectMember));
  objectMembers.set(ast, result);
  return result;
};
