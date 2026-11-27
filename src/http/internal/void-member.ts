/** Rewrite visible schema nodes to guard erasing Void members and to record native Option wrapper reads. */
import {
  Effect,
  Exit,
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
  isOptionDeclaration,
  readsOptionPayload,
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
const guardedOptionRivals = new WeakMap<SchemaAST.AST, SchemaAST.AST>();

const record = Symbol("record Option wrapper reads");
interface WrapperNote {
  used: boolean;
}

type ReadOptions = SchemaAST.ParseOptions & {
  readonly [record]?: WrapperNote;
};

/** Parse options that record whether a decode consumed a native Option as encoded input. */
export const recordingWrapperInto = (
  note: WrapperNote,
  options?: SchemaAST.ParseOptions,
): ReadOptions => ({ ...options, [record]: note });

type Parser = (
  input: unknown,
  options: SchemaAST.ParseOptions,
) => Effect.Effect<unknown, SchemaIssue.Issue, unknown>;
type Compiler = (ast: SchemaAST.AST) => Parser;

const copyAst = (ast: SchemaAST.AST, changes: object): SchemaAST.AST =>
  Object.assign(
    Object.create(Object.getPrototypeOf(ast)) as SchemaAST.AST,
    ast,
    changes,
  );

const noteWrapper = Schema.makeFilter((input, _ast, options: ReadOptions) => {
  const note = options[record];
  if (note !== undefined && Option.isOption(input)) note.used = true;
  return true;
});

// On a successful wire parse, Effect applies encodingChecks to the original input, where the
// wrapper is still visible. Checked on Effect 4.0.7 and 4.1.5. Revisit when Effect exposes a public
// hook for this input or a peer update changes where these checks run.
const notingWrapper = (ast: SchemaAST.AST): SchemaAST.AST =>
  copyAst(ast, {
    encodingChecks: [
      ...("encodingChecks" in ast ? (ast.encodingChecks ?? []) : []),
      noteWrapper,
    ],
  });

/** Observe parser success without changing Effect's synchronous parser result. */
const onSuccess = (
  result: ReturnType<Parser>,
  recordSuccess: () => void,
): ReturnType<Parser> => {
  if (!Exit.isExit(result))
    return Effect.tap(result, Effect.sync(recordSuccess));
  if (Exit.isSuccess(result)) recordSuccess();
  return result;
};

/** Each alternative only contributes its notes if it was able to read the value. */
const notingMembers = (ast: SchemaAST.Union): SchemaAST.AST => {
  // Delegate to Effect's internal union parser to preserve its selection and read order while
  // observing each member separately. Checked on Effect 4.0.7 and 4.1.5. Revisit when Effect exposes
  // a public hook for member parsing or a peer update changes the getParser contract.
  const original = ast as SchemaAST.Union & {
    getParser(compile: Compiler, compileField?: Compiler): Parser;
  };
  return copyAst(ast, {
    getParser(compile: Compiler, compileField?: Compiler): Parser {
      return original.getParser((member) => {
        const parse = compile(member);
        return (input, options: ReadOptions) => {
          const parent = options[record];
          if (parent === undefined) return parse(input, options);
          const child = { used: false };
          return onSuccess(
            parse(input, recordingWrapperInto(child, options)),
            () => {
              parent.used ||= child.used;
            },
          );
        };
      }, compileField);
    },
  });
};

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

/** Let a relaxed read use the actual plain payload when neither side needs any of its keys. */
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

/** Record reads that take a native Option wrapper as the wire value. */
export const guardReading = (root: SchemaAST.AST): SchemaAST.AST =>
  guard(root, true);

type WrapperPosition = "source" | "rival" | undefined;

const guard = (root: SchemaAST.AST, reading: boolean): SchemaAST.AST => {
  const visit = (
    ast: SchemaAST.AST,
    position?: WrapperPosition,
  ): SchemaAST.AST => {
    const cache =
      position === "source"
        ? guardedOptionSources
        : position === "rival"
          ? guardedOptionRivals
          : reading
            ? guardedReads
            : guardedVoids;
    const known = cache.get(ast);
    if (known !== undefined) return known;
    const rewritten = rewrite(ast, position);
    // Follow unions and suspensions to their actual wire reader. A native Option schema
    // can legitimately take the wrapper as its own value, even inside another Option codec.
    const result =
      ast.encoding === undefined &&
      ast._tag !== "Suspend" &&
      ast._tag !== "Union" &&
      ((position === "source" && !isOptionDeclaration(ast)) ||
        (position === "rival" && ast._tag === "Objects"))
        ? notingWrapper(rewritten)
        : rewritten;
    cache.set(ast, result);
    return result;
  };
  const rewrite = (
    ast: SchemaAST.AST,
    position: WrapperPosition,
  ): SchemaAST.AST => {
    if (!reading && isPlainVoid(ast)) return guardVoid(ast);
    const struct = ast._tag === "Objects";
    const list = ast._tag === "Arrays";
    const union = ast._tag === "Union";
    const suspended = ast._tag === "Suspend";
    const isClass = classFields(ast) !== undefined;
    if (!reading && !struct && !list && !union && !suspended && !isClass)
      return ast;
    const unwraps = reading && readsOptionPayload(ast);
    const wirePosition = unwraps
      ? "source"
      : position !== undefined && isOptionDeclaration(ast)
        ? undefined
        : position;
    const last = ast.encoding?.at(-1);
    const encoding =
      (reading || !suspended) && ast.encoding
        ? mapSame(ast.encoding, (link) => {
            let target = visit(
              link.to,
              link === last ? wirePosition : undefined,
            );
            if (unwraps && ast.encoding?.length === 1)
              target = readFieldlessPayload(ast, link.to, target);
            return target === link.to
              ? link
              : new SchemaAST.Link(target, link.transformation);
          })
        : ast.encoding;
    // Only the wire-most node at this position reads the wrapper as supplied.
    const raw = ast.encoding === undefined ? position : undefined;
    if (suspended) {
      // Follow a suspended schema only when it is read, so a recursive one stays finite.
      let target: SchemaAST.AST | undefined;
      return new SchemaAST.Suspend(
        () => (target ??= visit(ast.thunk(), raw)),
        ast.annotations,
        undefined,
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
    const hasOption = reading && ast.types.some(readsOptionPayload);
    const members = mapSame(ast.types, (member) =>
      visit(member, raw ?? (hasOption ? "rival" : undefined)),
    );
    if (encoding === ast.encoding && members === ast.types) return ast;
    const rewritten = new SchemaAST.Union(
      members,
      ast.options,
      ast.annotations,
      ast.checks,
      encoding,
      ast.context,
      ast.encodingChecks,
    );
    return reading && members !== ast.types
      ? notingMembers(rewritten)
      : rewritten;
  };
  return visit(root);
};
