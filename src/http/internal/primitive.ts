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
