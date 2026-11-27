import {
  Effect,
  Option,
  Predicate,
  Schema,
  SchemaAST,
  SchemaIssue,
  SchemaParser,
  SchemaTransformation,
} from "effect";
import {
  classFields,
  hasDefinedFields,
  hasHiddenContent,
  unwrapsNativeOption,
} from "./excess.js";
import { isPlainData } from "./plain.js";
import { replaceEncoding } from "./schema-ast.js";
import { extraArrayField } from "./writer-error.js";

const jsonVoid = Schema.toCodecJson(Schema.Void).ast.encoding?.[0];

const isPlainVoid = (ast: SchemaAST.AST): ast is SchemaAST.Void =>
  ast._tag === "Void" &&
  (ast.encoding === undefined ||
    (ast.encoding.length === 1 && ast.encoding[0] === jsonVoid));

/**
 * Whether a value would be erased as `undefined`: anything but nothing, or an object or list of it.
 * A list's named field counts, as it does for every writer, which refuses it rather than drop it.
 */
const holdsSomething = (value: unknown): boolean =>
  typeof value === "object" && value !== null
    ? hasDefinedFields(value) ||
      (Array.isArray(value) &&
        extraArrayField(value, value.length) !== undefined) ||
      hasHiddenContent(value)
    : value !== undefined && value !== null;

const guardVoid = (member: SchemaAST.Void) => {
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
      holdsSomething(input)
        ? Effect.fail(new SchemaIssue.InvalidType(member, input, options))
        : parse(input, options),
    { expected: "void", ...member.annotations },
    undefined,
    member.encoding,
    member.context,
    undefined,
    () => (input, _self, options) =>
      Predicate.isObjectOrArray(input) || holdsSomething(input)
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
const guardedReads = new WeakMap<SchemaAST.AST, SchemaAST.AST>();
const guardedOptionSources = new WeakMap<SchemaAST.AST, SchemaAST.AST>();

const unwrappedInput = Schema.makeFilter(
  (value) =>
    !Option.isOption(value) || "Expected a payload without an Option wrapper",
);

interface ClosedPayload {
  readonly fields: ReadonlyArray<PropertyKey>;
  readonly takesEmpty: boolean;
}

/** The declared fields and empty-object behavior of a closed, untransformed payload. */
const closedPayload = (ast: SchemaAST.AST): ClosedPayload | undefined => {
  if (ast.encoding !== undefined) return undefined;
  if (ast._tag === "Union" && ast.options?.mode !== "oneOf") {
    const fields: PropertyKey[] = [];
    let takesEmpty = false;
    for (const member of ast.types) {
      if (member._tag === "Null" || member._tag === "Undefined") continue;
      const shape = closedPayload(member);
      if (shape === undefined) return undefined;
      fields.push(...shape.fields);
      takesEmpty ||= shape.takesEmpty;
    }
    return { fields, takesEmpty };
  }
  if (
    ast._tag !== "Objects" ||
    ast.encodingChecks !== undefined ||
    ast.propertySignatures.length === 0 ||
    ast.indexSignatures.length > 0
  )
    return undefined;
  return {
    fields: ast.propertySignatures.map(({ name }) => name),
    takesEmpty: ast.propertySignatures.every(({ type }) =>
      SchemaAST.isOptional(type),
    ),
  };
};

/** Where the old relaxed read obtained an empty payload without losing a declared field. */
const readFieldlessPayload = (
  ast: SchemaAST.Declaration,
  source: SchemaAST.AST,
  guarded: SchemaAST.AST,
): SchemaAST.AST => {
  const decoded = closedPayload(ast.typeParameters[0]!);
  const encoded = closedPayload(source);
  if (!decoded?.takesEmpty || !encoded?.takesEmpty) return guarded;
  const fields = [...new Set([...decoded.fields, ...encoded.fields])];
  const usePayload = SchemaTransformation.transformEffect({
    decode: (input: unknown, options) => {
      if (
        options.onExcessProperty !== "error" &&
        Option.isOption(input) &&
        Option.isSome(input)
      ) {
        const payload: unknown = input.value;
        if (
          typeof payload === "object" &&
          payload !== null &&
          !Array.isArray(payload) &&
          isPlainData(payload) &&
          !fields.some((key) => key in input || Object.hasOwn(payload, key))
        )
          return Effect.succeed(payload);
      }
      return Effect.succeed(input);
    },
    encode: (input: unknown) => Effect.succeed(input),
  });
  return SchemaAST.decodeTo(Schema.Unknown.ast, guarded, usePayload);
};

/** The encoded reading reached the wrapper check and had no independent parse failure. */
export const refusedOptionSource = (issue: SchemaIssue.Issue): boolean => {
  switch (issue._tag) {
    case "Filter":
      return issue.filter === unwrappedInput;
    case "Pointer":
    case "Encoding":
      return refusedOptionSource(issue.issue);
    case "Composite":
      return issue.issues.every(refusedOptionSource);
    case "AnyOf":
      return issue.issues.some(refusedOptionSource);
    default:
      return false;
  }
};

/**
 * A schema whose every visible Void declines what it would erase: any value but `undefined`, `null`
 * and an object or a list that holds nothing. Nothing else changes: in a union another member can then keep the value, and anywhere
 * else the parser refuses it where it is. Void's ordinary behavior, missing and JSON null included,
 * stays with its context and encoding links.
 *
 * @remarks
 * Visible means through structs, lists, unions, suspensions and encodings, and a class's fields.
 * Effect builds a class from fields its struct has read, without reading them again, so the struct
 * it is built from can stand in. Any other declaration is opaque.
 */
export const guardVoids = (root: SchemaAST.AST): SchemaAST.AST =>
  guard(root, false);

/** Also stop a native Option from being read as an unwrapping codec's encoded struct. */
export const guardReading = (root: SchemaAST.AST): SchemaAST.AST =>
  guard(root, true);

const guard = (root: SchemaAST.AST, reading: boolean): SchemaAST.AST => {
  const visit = (ast: SchemaAST.AST, optionSource = false): SchemaAST.AST => {
    const cache = optionSource
      ? guardedOptionSources
      : reading
        ? guardedReads
        : guardedVoids;
    const known = cache.get(ast);
    if (known !== undefined) return known;
    const result = rewrite(ast, optionSource);
    cache.set(ast, result);
    return result;
  };
  const rewrite = (
    ast: SchemaAST.AST,
    optionSource: boolean,
  ): SchemaAST.AST => {
    if (!reading && isPlainVoid(ast)) return guardVoid(ast);
    const struct = ast._tag === "Objects";
    const list = ast._tag === "Arrays";
    const union = ast._tag === "Union";
    const suspended = ast._tag === "Suspend";
    const isClass = classFields(ast) !== undefined;
    if (!reading && !struct && !list && !union && !suspended && !isClass)
      return ast;
    const unwraps = reading && unwrapsNativeOption(ast);
    const last = ast.encoding?.at(-1);
    const encoding =
      (reading || !suspended) && ast.encoding
        ? mapSame(ast.encoding, (link) => {
            let target = visit(
              link.to,
              link === last && (optionSource || unwraps),
            );
            if (
              unwraps &&
              ast._tag === "Declaration" &&
              ast.encoding?.length === 1
            )
              target = readFieldlessPayload(ast, link.to, target);
            return target === link.to
              ? link
              : new SchemaAST.Link(target, link.transformation);
          })
        : ast.encoding;
    // Only the wire-most node at this position reads the wrapper as supplied.
    const raw = optionSource && ast.encoding === undefined;
    if (suspended) {
      // Follow a suspended schema only when it is read, so a recursive one stays finite.
      let target: SchemaAST.AST | undefined;
      return new SchemaAST.Suspend(
        () => (target ??= visit(ast.thunk(), raw)),
        ast.annotations,
        reading ? ast.checks : undefined,
        encoding,
        ast.context,
      );
    }
    if (ast._tag === "Declaration" && isClass)
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
    if (struct) {
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
      return !raw &&
        encoding === ast.encoding &&
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
            raw
              ? [...(ast.encodingChecks ?? []), unwrappedInput]
              : ast.encodingChecks,
          );
    }
    if (list) {
      const elements = mapSame(ast.elements, (element) => visit(element));
      const rest = mapSame(ast.rest, (element) => visit(element));
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
    if (!union) return replaceEncoding(ast, encoding);
    const hasOption = reading && ast.types.some(unwrapsNativeOption);
    const members = mapSame(ast.types, (member) =>
      visit(member, raw || hasOption),
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
