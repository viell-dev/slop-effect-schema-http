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
