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

/** Unencoded union members that cannot consume an actual object; Void deliberately does not qualify. */
export const isNonObjectAlternative = (ast: SchemaAST.AST): boolean =>
  ast.encoding === undefined && nonObjectTags.has(ast._tag);
