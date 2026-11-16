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

const qualifies = (
  ast: SchemaAST.AST,
  active: Set<SchemaAST.AST>,
  known: Map<SchemaAST.AST, boolean>,
): boolean => {
  if (ast.encoding !== undefined) return false;
  if (nonObjectTags.has(ast._tag)) return true;
  if (ast._tag !== "Union") return false;
  const cached = known.get(ast);
  if (cached !== undefined) return cached;
  // Only a mutated AST forms a union cycle; decline it instead of recursing forever.
  if (active.has(ast)) return false;
  active.add(ast);
  const result = ast.types.every((member) => qualifies(member, active, known));
  active.delete(ast);
  known.set(ast, result);
  return result;
};

/**
 * Unencoded union members that cannot consume an actual object; Void deliberately does not qualify.
 *
 * An unencoded union qualifies when every member does, so `Schema.Literals` and
 * `Schema.NullOr(Schema.String)` read like their flat members. Shared members are visited once.
 */
export const isNonObjectAlternative = (ast: SchemaAST.AST): boolean =>
  qualifies(ast, new Set(), new Map());
