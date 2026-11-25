import {
  Effect,
  Predicate,
  Schema,
  SchemaAST,
  SchemaIssue,
  SchemaParser,
} from "effect";
import { classFields, hasDefinedFields } from "./excess.js";

const jsonVoid = Schema.toCodecJson(Schema.Void).ast.encoding?.[0];

const isPlainVoid = (ast: SchemaAST.AST): ast is SchemaAST.Void =>
  ast._tag === "Void" &&
  (ast.encoding === undefined ||
    (ast.encoding.length === 1 && ast.encoding[0] === jsonVoid));

const guard = (member: SchemaAST.Void) => {
  // Declaration.flip swaps checks to the opposite side. Delegate to the original type parser
  // so checks still run on Void's result in both directions.
  const parse = SchemaParser.decodeUnknownEffect(
    Schema.make<Schema.Void>(
      new SchemaAST.Void(member.annotations, member.checks),
    ),
  );
  return new SchemaAST.Declaration(
    [],
    () => (input, _self, options) =>
      hasDefinedFields(input)
        ? Effect.fail(new SchemaIssue.InvalidType(member, input, options))
        : parse(input, options),
    { expected: "void", ...member.annotations },
    undefined,
    member.encoding,
    member.context,
    undefined,
    () => (input, _self, options) =>
      Predicate.isObjectOrArray(input)
        ? Effect.fail(new SchemaIssue.InvalidType(member, input, options))
        : parse(input, options),
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

const guardedVoids = new WeakMap<SchemaAST.AST, SchemaAST.AST>();

/**
 * A schema whose every visible Void declines what it would erase: an object or a list that holds
 * something. Nothing else changes: in a union another member can then keep the value, and anywhere
 * else the parser refuses it where it is. Void's ordinary behavior, missing and JSON null included,
 * stays with its context and encoding links.
 *
 * @remarks
 * Visible means through structs, lists, unions, suspensions and encodings, and a class's fields.
 * Effect builds a class from fields its struct has read, without reading them again, so the struct
 * it is built from can stand in. Any other declaration is opaque.
 */
export const guardVoids = (root: SchemaAST.AST): SchemaAST.AST => {
  const visit = (ast: SchemaAST.AST): SchemaAST.AST => {
    const known = guardedVoids.get(ast);
    if (known !== undefined) return known;
    const result = rewrite(ast);
    guardedVoids.set(ast, result);
    return result;
  };
  const rewrite = (ast: SchemaAST.AST): SchemaAST.AST => {
    if (isPlainVoid(ast)) return guard(ast);
    if (ast._tag === "Suspend") {
      // Follow a suspended schema only when it is read, so a recursive one stays finite.
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
            ast.typeParameters.map((parameter) =>
              parameter === ast.encoding![0].to ? encoding![0].to : parameter,
            ),
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
    if (ast._tag !== "Union") return ast;
    const members = mapSame(ast.types, visit);
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
