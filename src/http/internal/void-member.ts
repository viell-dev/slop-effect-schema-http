import {
  Effect,
  Predicate,
  Schema,
  SchemaAST,
  SchemaIssue,
  SchemaParser,
} from "effect";
import { hasDefinedFields } from "./excess.js";
import { shapes } from "./primitive.js";

// Effect 4.0.7 and 4.1.4 spread parse options, preserving this per-read observer. Revisit the
// channel if a supported peer stops forwarding symbol keys.
const onDecline = Symbol("track Void refusal");
type GuardOptions = SchemaAST.ParseOptions & {
  readonly [onDecline]?: () => void;
};

export const observeVoid = (
  options: SchemaAST.ParseOptions,
  declined: () => void,
): GuardOptions => ({ ...options, [onDecline]: declined });

const jsonVoid = Schema.toCodecJson(Schema.Void).ast.encoding?.[0];

const isPlainVoid = (ast: SchemaAST.AST): ast is SchemaAST.Void =>
  ast._tag === "Void" &&
  (ast.encoding === undefined ||
    (ast.encoding.length === 1 && ast.encoding[0] === jsonVoid));

/**
 * Tests alternatives at their containing union, including any protected Void branch. `grouped`
 * asks about a member of a member union, which the caller reached without the union's context.
 */
export type AliasAlternative = (
  union: SchemaAST.AST,
  member: SchemaAST.AST,
  grouped?: boolean,
) => boolean;

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
    () => (input, _self, options: GuardOptions) => {
      if (!hasDefinedFields(input)) return parse(input, options);
      options[onDecline]?.();
      return Effect.fail(new SchemaIssue.InvalidType(member, input, options));
    },
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

/**
 * Keep the union and its other members intact. The strict parser can decline the built-in Void
 * member before it erases the value. Its ordinary behavior (including missing and JSON null)
 * is represented by the same context and encoding links.
 */
export const guardVoidMembers = (root: SchemaAST.AST) => {
  const choices = new WeakSet<SchemaAST.AST>();
  const cache = new WeakMap<SchemaAST.AST, SchemaAST.AST>();
  const alternatives = new WeakMap<SchemaAST.AST, SchemaAST.AST>();
  const objectMembers = new WeakMap<SchemaAST.AST, boolean>();
  const objectMember = (ast: SchemaAST.AST): boolean => {
    const cached = objectMembers.get(ast);
    if (cached !== undefined) return cached;
    const result =
      ast._tag === "Objects" ||
      ast._tag === "Arrays" ||
      ast._tag === "Any" ||
      ast._tag === "Unknown" ||
      ast._tag === "ObjectKeyword" ||
      (ast._tag === "Union" && ast.types.some(objectMember));
    objectMembers.set(ast, result);
    return result;
  };
  // One classification per build. A primitive here refuses both an object and a list.
  const shape = shapes();
  const guardedPrimitives = new WeakSet<SchemaAST.AST>();
  const guardedMembers = new WeakMap<SchemaAST.AST, WeakSet<SchemaAST.AST>>();
  // One union can be rewritten guarded in one place and left unguarded in another, yet its guard is
  // filed under the shared identity. A grouped lookup trusts that guard only if no rewrite left it.
  const unguarded = new WeakSet<SchemaAST.AST>();
  const isAliasAlternative: AliasAlternative = (
    union,
    member,
    grouped = false,
  ) =>
    (guardedMembers.get(union)?.has(member) === true &&
      !(grouped && unguarded.has(union))) ||
    (shape.record(member) && shape.array(member));
  const visit = (ast: SchemaAST.AST) => visitAlternative(ast, false);
  const visitAlternative = (
    ast: SchemaAST.AST,
    besideObject: boolean,
  ): SchemaAST.AST => {
    const known = besideObject ? alternatives : cache;
    const cached = known.get(ast);
    if (cached !== undefined) return cached;
    const result = rewrite(ast, besideObject);
    known.set(ast, result);
    return result;
  };
  const rewrite = (
    ast: SchemaAST.AST,
    besideObject: boolean,
  ): SchemaAST.AST => {
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
      (besideObject || ast.types.some(objectMember));
    if (!protect) unguarded.add(ast);
    const guarded = new WeakSet<SchemaAST.AST>();
    const members = mapSame(ast.types, (member) => {
      if (protect && isPlainVoid(member)) {
        choices.add(ast);
        guarded.add(member);
        return guard(member);
      }
      if (protect && member._tag === "Union" && member.encoding === undefined) {
        const rewritten = visitAlternative(member, true);
        if (choices.has(member)) choices.add(ast);
        if (guardedPrimitives.has(member)) guarded.add(member);
        return rewritten;
      }
      return visit(member);
    });
    if (protect && choices.has(ast)) {
      guardedMembers.set(ast, guarded);
      if (ast.types.every((member) => isAliasAlternative(ast, member)))
        guardedPrimitives.add(ast);
    }
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
  return { ast: visit(root), choices, isAliasAlternative };
};
