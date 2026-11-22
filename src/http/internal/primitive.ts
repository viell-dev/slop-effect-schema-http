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

/** Which actual cells a union member cannot consume, by the AST alone. */
export interface Shapes {
  /**
   * An ordinary or null-prototype object cannot reach primitives, arrays or tuples. Void
   * deliberately does not qualify.
   *
   * A union qualifies when every member does, so `Schema.Literals` and
   * `Schema.NullOr(Schema.String)` read like their flat members. An encoding qualifies when every
   * link is a plain transformation and every stage qualifies, as in `Schema.FiniteFromString`.
   */
  readonly record: (ast: SchemaAST.AST) => boolean;
  /** An array cannot reach primitives or objects that state a property or index signature. */
  readonly array: (ast: SchemaAST.AST) => boolean;
}

/** One metadata build shares these answers, so each node is classified once per cell kind. */
export const shapes = (): Shapes => {
  const records = new Map<SchemaAST.AST, boolean>();
  const arrays = new Map<SchemaAST.AST, boolean>();
  return {
    record: (ast) => refuses(ast, "record", records),
    array: (ast) => refuses(ast, "array", arrays),
  };
};
