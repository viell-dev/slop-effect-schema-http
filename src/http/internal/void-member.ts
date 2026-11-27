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
  renamedPairs,
} from "./excess.js";
import { isPlainData } from "./plain.js";
import { stageRefuses } from "./primitive.js";
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
  map: (item: A, index: number) => A,
): readonly [A, ...A[]];
function mapSame<A>(
  items: readonly A[],
  map: (item: A, index: number) => A,
): readonly A[];
function mapSame<A>(
  items: readonly A[],
  map: (item: A, index: number) => A,
): readonly A[] {
  const mapped = items.map(map);
  return mapped.every((item, index) => item === items[index]) ? items : mapped;
}

const guardedVoids = new WeakMap<SchemaAST.AST, SchemaAST.AST>();
const guardedReads = new WeakMap<SchemaAST.AST, SchemaAST.AST>();
const guardedOptionSources = new WeakMap<SchemaAST.AST, SchemaAST.AST>();
const guardedOptionRivals = new WeakMap<SchemaAST.AST, SchemaAST.AST>();

const record = Symbol("record Option wrapper reads");

/** The native Options a decode consumed as encoded input, as it met them. */
type WrapperNote = Set<Option.Option<unknown>>;

type ReadOptions = SchemaAST.ParseOptions & {
  readonly [record]?: WrapperNote;
};

/** Parse options that record each native Option a decode consumes as encoded input. */
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
  if (note !== undefined && Option.isOption(input)) note.add(input);
  return true;
});

/** The guarded nodes that note a native Option they read. */
const notingNodes = new WeakSet<SchemaAST.AST>();

// On a successful wire parse, Effect applies encodingChecks to the original input, where the
// wrapper is still visible. Checked on Effect 4.0.7 and 4.1.5. Revisit when Effect exposes a public
// hook for this input or a peer update changes where these checks run.
const notingWrapper = (ast: SchemaAST.AST): SchemaAST.AST => {
  const noting = copyAst(ast, {
    encodingChecks: [
      ...("encodingChecks" in ast ? (ast.encodingChecks ?? []) : []),
      noteWrapper,
    ],
  });
  notingNodes.add(noting);
  return noting;
};

/**
 * Whether a node of a {@link guardReading} schema can note a native Option it reads: it records the
 * wrappers it takes, and it takes objects, as an open schema or a struct does and text does not.
 */
export const notesWrapper = (ast: SchemaAST.AST): boolean =>
  notingNodes.has(ast) && !stageRefuses(ast, "record");

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
          const child: WrapperNote = new Set();
          return onSuccess(
            parse(input, recordingWrapperInto(child, options)),
            () => {
              for (const wrapper of child) parent.add(wrapper);
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

/**
 * The nodes a decoded node reads through, wire-most first, ending with the node itself, and
 * whether one of them unwraps an Option. Its encoded projection is that of its wire-most node.
 */
const chainOf = (
  ast: SchemaAST.AST,
): {
  readonly nodes: ReadonlyArray<SchemaAST.AST>;
  readonly unwraps: boolean;
} => {
  const nodes = [ast];
  let unwraps = readsOptionPayload(ast);
  let type = ast;
  while (type.encoding !== undefined) {
    type = type.encoding.at(-1)!.to;
    unwraps ||= readsOptionPayload(type);
    nodes.unshift(type);
  }
  return { nodes, unwraps };
};

/**
 * Decoded nodes whose children a wire node's children are encoded projections of, wire-most
 * first. Each layer's children are in turn projections of the next layer's, as a struct that
 * `Schema.encodeKeys` renames sits on its own projected wire struct.
 */
type Layers = ReadonlyArray<SchemaAST.AST>;

/**
 * The layers a wire node may be read through, as alternatives. There is one unless a rename above
 * it could have written any of several fields at one name: each of them is then an alternative,
 * since preparation cannot tell which the rename wrote.
 */
type Projection = ReadonlyArray<Layers>;

interface Child {
  readonly key: PropertyKey;
  readonly type: SchemaAST.AST;
}

// Private keys for positions, so no property name of a caller's schema can collide with one.
const positionKeys = new Map<string, symbol>();
const positionKey = (kind: "index" | "rest", at: number): symbol => {
  const name = `${kind} ${at}`;
  let key = positionKeys.get(name);
  if (key === undefined) {
    key = Symbol(name);
    positionKeys.set(name, key);
  }
  return key;
};

/** A node's children, each under the key that relates it to the same child of a projection. */
const childrenOf = (ast: SchemaAST.AST): ReadonlyArray<Child> => {
  switch (ast._tag) {
    case "Declaration": {
      // A class is read through the struct of its fields.
      const fields = classFields(ast);
      return fields === undefined ? [] : childrenOf(fields);
    }
    case "Objects":
      return [
        ...ast.propertySignatures.map(({ name, type }) => ({
          key: name,
          type,
        })),
        ...ast.indexSignatures.map(({ type }, index) => ({
          key: positionKey("index", index),
          type,
        })),
      ];
    case "Arrays":
      return [
        ...ast.elements.map((type, index) => ({ key: index, type })),
        ...ast.rest.map((type, index) => ({
          key: positionKey("rest", index),
          type,
        })),
      ];
    case "Union":
      return ast.types.map((type, index) => ({ key: index, type }));
    default:
      return [];
  }
};

/** The schema node each rewritten node stands for, so a projection is recognised after a guard. */
const origins = new WeakMap<SchemaAST.AST, SchemaAST.AST>();
const originOf = (ast: SchemaAST.AST): SchemaAST.AST => origins.get(ast) ?? ast;

/**
 * The child of `layer` that the child of `reference` under `key` is the projection of. Where
 * `layer` is written as `reference` by its last encoding, only a rename's own pairing says which,
 * by identity with `toEncoded`'s node, and any other transformation pairs nothing. Otherwise
 * `reference` is a projection, which keeps the keys. Identity alone does not say which child a
 * projection came from, as unrelated children can share one, so no other child is guessed.
 *
 * @remarks
 * Below a projection the child under the same key is taken without comparing their nodes.
 * `toEncoded` of a projected node that holds a suspension builds new copies of every node above
 * it, since Effect builds a new suspension each time, so the child of `reference` need not be the
 * node `toEncoded` returns for that of `layer`. The keys still pair them because each layer is the
 * projection of the next or written as it, down from a rename's own pairing. So layers start only
 * where a node is written as its wire node by its last encoding, where only a rename pairs
 * anything, and they continue into a suspension's target only where the suspension has no encoding
 * of its own. A suspension written as another by a transformation says nothing of how their
 * targets' children correspond.
 */
const counterpart = (
  layer: SchemaAST.AST,
  reference: SchemaAST.AST,
  key: PropertyKey,
):
  | SchemaAST.AST
  | { readonly ambiguous: ReadonlyArray<SchemaAST.AST> }
  | undefined => {
  const decoded = originOf(layer);
  const link = decoded.encoding?.at(-1);
  if (link !== undefined && link.to === originOf(reference)) {
    const pairing = renamedPairs(classFields(decoded) ?? decoded, link);
    const ambiguous = pairing?.ambiguous.get(key);
    return ambiguous !== undefined ? { ambiguous } : pairing?.pairs.get(key);
  }
  return childrenOf(layer).find((child) => child.key === key)?.type;
};

interface Interned<A> {
  readonly next: WeakMap<object, Interned<A>>;
  items?: ReadonlyArray<A>;
}

/** One array per sequence of the same items, so the caches below recognise one seen before. */
const interning = <A extends object>() => {
  const first = new WeakMap<object, Interned<A>>();
  return (items: ReadonlyArray<A>): ReadonlyArray<A> | undefined => {
    if (items.length === 0) return undefined;
    let next = first;
    let entry: Interned<A> | undefined;
    for (const item of items) {
      entry = next.get(item);
      if (entry === undefined) {
        entry = { next: new WeakMap() };
        next.set(item, entry);
      }
      next = entry.next;
    }
    return (entry!.items ??= items);
  };
};

const internLayers = interning<SchemaAST.AST>();
const internAlternatives = interning<Layers>();

/**
 * The layers without those the next one makes redundant. A layer with no encoding of its own before
 * another such layer is that one's projection: it holds no Option codec and writes no name, and the
 * keys pair through it unchanged. One before a layer with an encoding stays, as a rename pairs only
 * with its own wire struct. Effect builds a new copy of a recursive schema's wire side for each
 * level, so keeping every projection would add a layer per level of a value.
 */
const withoutProjections = (layers: Layers): Layers =>
  layers.filter(
    (layer, at) =>
      at === layers.length - 1 ||
      layer.encoding !== undefined ||
      layers[at + 1]!.encoding !== undefined,
  );

/**
 * One projection per sequence of alternatives, each interned, without repeats or empty ones. The
 * same alternatives found in another order intern apart, which only costs a cache entry.
 */
const internProjection = (
  alternatives: ReadonlyArray<Layers>,
): Projection | undefined =>
  internAlternatives([
    ...new Set(
      alternatives.flatMap((layers) => {
        const interned = internLayers(withoutProjections(layers));
        return interned === undefined ? [] : [interned];
      }),
    ),
  ]);

interface Projected {
  readonly projection: Projection | undefined;
  readonly unwraps: boolean;
}

/**
 * The layers and Option evidence for the child of `wire` under `key`, where it is projected.
 *
 * @remarks
 * Where a rename could have written several fields under `key`, each of them continues as its own
 * alternative, and the wrapper is refused if any of them may unwrap an Option, here or below. No
 * layer above such a rename pairs anything: it is written as the renamed struct, which is no wire
 * struct a rename could pair with.
 */
const projectChild = (
  projection: Projection | undefined,
  wire: SchemaAST.AST,
  key: PropertyKey,
): Projected => {
  const next: Layers[] = [];
  let unwraps = false;
  for (const layers of projection ?? []) {
    const nodes: SchemaAST.AST[] = [];
    let candidates: ReadonlyArray<SchemaAST.AST> | undefined;
    let reference = wire;
    for (const layer of layers) {
      const decoded = counterpart(layer, reference, key);
      if (decoded === undefined) break;
      if ("ambiguous" in decoded) {
        candidates = decoded.ambiguous;
        break;
      }
      const chain = chainOf(decoded);
      nodes.push(...chain.nodes);
      unwraps ||= chain.unwraps;
      reference = layer;
    }
    if (candidates === undefined) next.push(nodes);
    // Any of these fields could be the one written here, so each continues as an alternative,
    // and the wrapper is refused if any of them may unwrap an Option. Here a suspension's target
    // is not known yet.
    else
      for (const type of candidates) {
        const chain = chainOf(type);
        unwraps ||= type._tag === "Suspend" || chain.unwraps;
        next.push([...nodes, ...chain.nodes]);
      }
  }
  return { projection: internProjection(next), unwraps };
};

/**
 * The layers a projected suspension's target is read with, in each alternative. A suspension with
 * an encoding of its own still marks its wire reader as a source where its target unwraps an
 * Option, as a codec there would, but its target adds no layers (see `counterpart`).
 */
const projectThunk = (projection: Projection | undefined): Projected => {
  let unwraps = false;
  const next = (projection ?? []).map((layers) =>
    layers.flatMap((layer) => {
      if (layer._tag !== "Suspend") return [];
      const chain = chainOf(layer.thunk());
      unwraps ||= chain.unwraps;
      return layer.encoding === undefined ? chain.nodes : [];
    }),
  );
  return { projection: internProjection(next), unwraps };
};

const projectedCaches = new WeakMap<
  Projection,
  Record<"source" | "rival" | "none", WeakMap<SchemaAST.AST, SchemaAST.AST>>
>();

const projectedCache = (
  projection: Projection,
  position: WrapperPosition,
): WeakMap<SchemaAST.AST, SchemaAST.AST> => {
  let caches = projectedCaches.get(projection);
  if (caches === undefined) {
    caches = {
      source: new WeakMap(),
      rival: new WeakMap(),
      none: new WeakMap(),
    };
    projectedCaches.set(projection, caches);
  }
  return caches[position ?? "none"];
};

const guard = (root: SchemaAST.AST, reading: boolean): SchemaAST.AST => {
  /**
   * Visit a node. While reading, `projection` holds the decoded nodes whose children `ast`'s
   * children are encoded projections of, so an Option codec dropped by the projection still marks
   * its wire reader as a source.
   */
  const visit = (
    ast: SchemaAST.AST,
    position?: WrapperPosition,
    projection?: Projection,
  ): SchemaAST.AST => {
    const cache =
      projection !== undefined
        ? projectedCache(projection, position)
        : position === "source"
          ? guardedOptionSources
          : position === "rival"
            ? guardedOptionRivals
            : reading
              ? guardedReads
              : guardedVoids;
    const known = cache.get(ast);
    if (known !== undefined) return known;
    const rewritten = rewrite(ast, position, projection);
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
    if (result !== ast) origins.set(result, originOf(ast));
    cache.set(ast, result);
    return result;
  };
  const rewrite = (
    ast: SchemaAST.AST,
    position: WrapperPosition,
    projection: Projection | undefined,
  ): SchemaAST.AST => {
    /** Visit a child, as a source if it projects a decoded Option codec's wire side. */
    const visitChild = (
      key: PropertyKey,
      child: SchemaAST.AST,
      childPosition?: WrapperPosition,
      projected = projectChild(projection, ast, key),
    ) =>
      visit(
        child,
        projected.unwraps ? "source" : childPosition,
        projected.projection,
      );
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
            // A wire schema built from the decoded fields' projections, as Schema.encodeKeys
            // builds one, pairs its children with this node's own.
            let target = visit(
              link.to,
              link === last ? wirePosition : undefined,
              reading &&
                link === last &&
                (link.to._tag === ast._tag ||
                  (isClass && link.to._tag === "Objects"))
                ? internProjection([[ast]])
                : undefined,
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
        () => {
          if (target !== undefined) return target;
          // A projected suspension reads the projection of its decoded counterpart's target.
          const projected = reading ? projectThunk(projection) : undefined;
          return (target = visit(
            ast.thunk(),
            projected?.unwraps === true ? "source" : raw,
            projected?.projection,
          ));
        },
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
        const type = visitChild(property.name, property.type);
        return type === property.type
          ? property
          : new SchemaAST.PropertySignature(property.name, type);
      });
      const indexes = mapSame(ast.indexSignatures, (index, at) => {
        const type = visitChild(positionKey("index", at), index.type);
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
      const elements = mapSame(ast.elements, (element, at) =>
        visitChild(at, element),
      );
      const rest = mapSame(ast.rest, (element, at) =>
        visitChild(positionKey("rest", at), element),
      );
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
    const projected = ast.types.map((_, at) =>
      projectChild(projection, ast, at),
    );
    const hasOption =
      reading &&
      ast.types.some(
        (member, at) => readsOptionPayload(member) || projected[at]!.unwraps,
      );
    const members = mapSame(ast.types, (member, at) =>
      visitChild(
        at,
        member,
        raw ?? (hasOption ? "rival" : undefined),
        projected[at],
      ),
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
