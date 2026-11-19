import { Equal, Schema, SchemaAST, SchemaIssue } from "effect";
import { stageRefuses } from "./primitive.js";

/** Where a key sits in a value, one step for each level. */
export type Path = ReadonlyArray<PropertyKey>;

type Ast = SchemaAST.AST;

/** Parse options that make a schema refuse what it would strip. */
export const strict: SchemaAST.ParseOptions = { onExcessProperty: "error" };

/**
 * The node a schema's encoding ends at. `toEncoded` gives the same names, but it flattens each
 * field's own encoding away, and that encoding is how a field says what it writes.
 */
export const encodedEnd = (ast: Ast): Ast => {
  const last = ast.encoding?.at(-1);
  return last === undefined ? ast : encodedEnd(last.to);
};

/**
 * The parts of a schema this can see. What a declaration holds, as an `Option` or a `Map` does, is
 * not among them: nothing here can reach it, so the schema's own reading applies there.
 */
const partsOf = (ast: Ast): ReadonlyArray<Ast> => {
  switch (ast._tag) {
    case "Objects":
      return [...ast.propertySignatures, ...ast.indexSignatures].map(
        ({ type }) => type,
      );
    case "Arrays":
      return [...ast.elements, ...ast.rest];
    case "Union":
      return ast.types;
    default:
      return [];
  }
};

/** Whether a schema can read an object's keys, and so can strip one of them. */
const readsKeys = (ast: Ast): boolean =>
  ast._tag === "Objects" ||
  ast._tag === "ObjectKeyword" ||
  ast._tag === "Suspend" ||
  ast._tag === "Unknown" ||
  ast._tag === "Any" ||
  partsOf(ast).some(readsKeys) ||
  (ast.encoding ?? []).some(({ to }) => readsKeys(to));

/** A choice of member: a union between objects, or a suspended schema, which may not exist yet. */
const isMemberChoice = (ast: Ast): boolean =>
  ast._tag === "Suspend" ||
  (ast._tag === "Union" && ast.types.filter(readsKeys).length > 1);

/**
 * A choice of side: two ends that do not state the same names, as a renamed field's do, or an
 * encoded end with a rest. A value on the encoded side can then fit the decoded side by losing the
 * names it holds. An encoded side with no keys, such as text, has none to lose.
 */
const isSideChoice = (ast: Ast): boolean => {
  const end = encodedEnd(ast);
  if (end === ast || !readsKeys(end)) return false;
  const decoded = fieldsOf(ast).map(({ name }) => name);
  const encoded = fieldsOf(end).map(({ name }) => name);
  return (
    decoded.length !== encoded.length ||
    decoded.some((name) => !encoded.includes(name)) ||
    (end._tag === "Objects" && end.indexSignatures.length > 0)
  );
};

const holding = (isChoice: (ast: Ast) => boolean) => {
  const holds = (ast: Ast): boolean =>
    isChoice(ast) ||
    partsOf(ast).some(holds) ||
    (ast.encoding ?? []).some(({ to }) => holds(to));
  return holds;
};

/**
 * {@link holding}, through suspended schemas too. Resolving one runs its thunk, which may name a
 * schema defined after the binding, so ask this only once a value is read, as {@link lazily} does.
 */
const holdingResolved = (isChoice: (ast: Ast) => boolean) => (ast: Ast) => {
  const seen = new Set<Ast>();
  const holds = (node: Ast): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    return (
      isChoice(node) ||
      (node._tag === "Suspend" ? holds(node.thunk()) : false) ||
      partsOf(node).some(holds) ||
      (node.encoding ?? []).some(({ to }) => holds(to))
    );
  };
  return holds(ast);
};

/** A question about a schema, asked the first time a value needs its answer. */
export const lazily = <A>(answer: () => A): (() => A) => {
  let known: { readonly value: A } | undefined;
  return () => (known ??= { value: answer() }).value;
};

/** The fields of a struct or class, as they are declared, with each field's own encoding. */
export const fieldsOf = (
  ast: Ast,
): ReadonlyArray<{ readonly name: PropertyKey; readonly type: Ast }> =>
  ast._tag === "Objects"
    ? ast.propertySignatures
    : ast._tag === "Declaration" && ast.encoding !== undefined
      ? fieldsOf(ast.encoding[0].to)
      : [];

const isObject = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

/** A plain object or a list, which can be taken apart. A class instance needs a reason to be. */
const isPlain = (value: unknown): value is Record<PropertyKey, unknown> => {
  if (!isObject(value)) return false;
  if (Array.isArray(value)) return true;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** An actual array position, rather than a property whose spelling merely converts to a number. */
const arrayIndex = (key: PropertyKey): number | undefined => {
  if (typeof key === "symbol") return undefined;
  const index = Number(key);
  return Number.isInteger(index) &&
    index >= 0 &&
    index < 0xffff_ffff &&
    String(index) === String(key)
    ? index
    : undefined;
};

/** The fields offered to a parser. Array metadata and holes do not supply cells. */
export const hasDefinedFields = (value: unknown): boolean =>
  isObject(value) &&
  Reflect.ownKeys(value).some(
    (key) =>
      (Array.isArray(value)
        ? arrayIndex(key) !== undefined
        : Object.prototype.propertyIsEnumerable.call(value, key)) &&
      value[key] !== undefined,
  );

const keysOf = (value: object, arrays = false): ReadonlyArray<PropertyKey> => {
  const list = arrays && Array.isArray(value);
  const length = list ? value.length : 0;
  const own = Reflect.ownKeys(value);
  const keys = new Set(
    own.filter(
      (key) =>
        Object.prototype.propertyIsEnumerable.call(value, key) ||
        (list && arrayIndex(key) !== undefined),
    ),
  );
  const positions = list
    ? own.filter((key) => {
        const index = arrayIndex(key);
        return index !== undefined && index < length;
      }).length
    : 0;
  if (list && positions < length) {
    // Array schemas also read hidden or inherited positions. Materialize those cells if another
    // cell needs rewriting; copying an enumerable-key list would compact or drop them.
    const visited = new Set<object>();
    let prototype: object | null = Object.getPrototypeOf(value);
    while (prototype !== null && !visited.has(prototype)) {
      visited.add(prototype);
      for (const key of Reflect.ownKeys(prototype)) {
        const index = arrayIndex(key);
        if (index !== undefined && index < length) keys.add(key);
      }
      prototype = Object.getPrototypeOf(prototype);
    }
  }
  return [...keys];
};

/** Whether a side only holds literals, and this value is none of them. */
const refuses = (side: Ast, value: unknown): boolean =>
  side._tag === "Literal"
    ? side.literal !== value
    : side._tag === "Union" &&
      side.types.every((member) => refuses(member, value));

/** Whether a literal field refuses a value on every side, which a tag can rule out by. */
const refusesLiteral = (type: Ast, value: unknown): boolean =>
  [type, ...(type.encoding ?? []).map(({ to }) => to)].every((side) =>
    refuses(side, value),
  );

const onlyLiterals = (ast: Ast): boolean =>
  ast._tag === "Literal" ||
  (ast._tag === "Union" &&
    ast.types.every(
      (member) => member.encoding === undefined && onlyLiterals(member),
    ));

/** Each side of an object transformation, without guessing which names correspond. */
const objectSides = (ast: Ast): ReadonlyArray<Ast> => [
  ast,
  ...(ast.encoding ?? []).flatMap(({ to }) => objectSides(to)),
];

/** Whether this view's literal tags make it impossible, without reading a default. */
const tagView = (
  side: Ast,
  value: Record<PropertyKey, unknown>,
  constructing: boolean,
) => {
  const tags = fieldsOf(side).filter(
    ({ type }) =>
      !SchemaAST.isOptional(type) && objectSides(type).every(onlyLiterals),
  );
  const mismatch = tags.some(
    ({ name, type }) =>
      value[name] !== undefined && refusesLiteral(type, value[name]),
  );
  const absent = tags.some(
    ({ name, type }) =>
      value[name] === undefined &&
      (!constructing || type.context?.constructorDefault === undefined),
  );
  return { impossible: mismatch || absent, mismatch };
};

/** A tag can choose on either side; both views must rule a member out before its fields go. */
const ruledOut = (member: Ast, value: unknown): boolean => {
  if (!isObject(value)) return false;
  const decoded = tagView(member, value, true);
  const encoded = tagView(SchemaAST.toEncoded(member), value, false);
  return (
    decoded.impossible &&
    encoded.impossible &&
    (decoded.mismatch || encoded.mismatch)
  );
};

/** A declaration built from what a struct reads, as a class is; {@link fieldsOf} gives its fields. */
const isStructDeclaration = (ast: Ast): boolean =>
  ast._tag === "Declaration" && ast.encoding?.[0]?.to._tag === "Objects";

/**
 * Whether this one node can read a value of this kind of container, as Effect's own parser for it
 * tells them apart: a record or a struct that states a field refuses an actual array, and an array
 * or tuple refuses any other object. Such a node holds none of the value's keys, wherever in a union
 * or under whichever parent it comes from. Each side is judged alone, so a member keeps every other
 * side that can read the value: an empty struct reads a list, and a codec's other steps keep theirs.
 *
 * A class has no list reading either. Its struct refuses a list once it states a field, and an empty
 * class's struct lets Effect copy the cells into an instance keyed by their indexes, the copy a list
 * never gets from preparation. So for a list's cells it states nothing, as a record does not, unless
 * it takes the list first, as {@link membersOf} describes.
 */
const readsContainer = (side: Ast, value: unknown): boolean =>
  !isObject(value) ||
  (Array.isArray(value)
    ? !stageRefuses(side, "array") && !isStructDeclaration(side)
    : !stageRefuses(side, "record"));

/** A step Effect reads a value through without this seeing its keys, so it keeps them all. */
const readsUnseen = (ast: Ast): boolean =>
  (ast._tag === "Declaration" && !isStructDeclaration(ast)) ||
  ast._tag === "Unknown" ||
  ast._tag === "Any" ||
  ast._tag === "ObjectKeyword";

/**
 * The schema a suspension stands for, through any chain of suspensions. A suspension with an encoding
 * of its own is a codec, so it stays as it is. Resolving runs the thunks, so ask only once a value
 * is read.
 */
const resolved = (ast: Ast): Ast => {
  const seen = new Set<Ast>();
  let node = ast;
  while (
    node._tag === "Suspend" &&
    node.encoding === undefined &&
    !seen.has(node)
  ) {
    seen.add(node);
    node = node.thunk();
  }
  return node;
};

/** Whether a codec reads this encoded side, or a member of it, through an unseen step. */
const unseenAt = (to: Ast, value: unknown, seen = new Set<Ast>()): boolean => {
  const node = resolved(to);
  if (seen.has(node)) return false;
  seen.add(node);
  return node._tag === "Union"
    ? node.types.some((member) => unseenAt(member, value, seen))
    : readsUnseen(node) && readsContainer(node, value);
};

/** Middleware on this very node, which can turn a refusal into a value of its own. */
const recoversHere = (ast: Ast): boolean =>
  (ast.encoding ?? []).some(
    ({ transformation }) => transformation._tag === "Middleware",
  );

/**
 * The schemas a value can be read against here: each member its tag leaves, on each side that can
 * read the value's container. A codec that reads its encoded side through an opaque declaration or
 * an open schema, suspended or as a member of a union there, holds what it reads as given, as an
 * empty struct does: its keys are not unstated, so if it cannot take the value, they are refused
 * rather than stripped. A member that is itself such a schema keeps the opaque reading below it.
 *
 * Middleware can recover from any refusal, which only its reading shows, so a node with middleware
 * and its encoding keep every side, as before container kinds were judged; its recovery is held to
 * {@link lostCells} instead.
 */
const sidesOf = (
  ast: Ast,
  value: unknown,
  judged = true,
): ReadonlyArray<Ast> => {
  const judges = judged && !recoversHere(ast);
  const reads = !judges || readsContainer(ast, value);
  const links = ast.encoding ?? [];
  return [
    ...(ast._tag === "Union"
      ? membersOf(ast, value)
      : ast._tag === "Suspend"
        ? sidesOf(ast.thunk(), value, judges)
        : reads
          ? [ast]
          : []),
    // A class ruled out for a list goes with the struct it is built from, not with later links,
    // such as the tuple a codec decodes the class from.
    ...(!reads && ast._tag === "Declaration" ? links.slice(1) : links).flatMap(
      ({ to }) => [
        ...(unseenAt(to, value) ? [asGiven] : []),
        ...sidesOf(to, value, judges),
      ],
    ),
  ];
};

/** A class with no fields, whose struct reads any value but null and undefined. A codec is not one. */
const isEmptyClass = (ast: Ast): boolean =>
  isStructDeclaration(ast) &&
  ast.encoding!.length === 1 &&
  isSignaturelessObject(ast.encoding![0]!.to);

/** A union whose members Effect tries in order, as one list with the members around it. */
const isAnyOf = (ast: Ast): ast is SchemaAST.Union =>
  ast._tag === "Union" &&
  ast.encoding === undefined &&
  (ast.options?.mode ?? "anyOf") === "anyOf";

/**
 * The sides of a union's members, each its tag leaves, in the order Effect tries them: a grouped
 * any-of union and a suspended member take their place in that order. An empty class before every
 * other member that can read a list takes any list by first fit and keeps its cells as given, so it
 * reads them as an empty struct does. A later one takes the list only when every earlier reader
 * refuses it, which only a reading shows; it is noted in `passed`, and {@link restoredCells} gives
 * it the caller's cells when it does. A guarded Void declines a list with a defined cell, and a list
 * without one has no cell to strip.
 */
const membersOf = (
  union: SchemaAST.Union,
  value: unknown,
  passed?: Array<Ast>,
) => {
  let taken = false;
  const visit = (members: ReadonlyArray<Ast>): ReadonlyArray<Ast> =>
    members
      .filter((member) => !ruledOut(member, value))
      .flatMap((member) => {
        const node = resolved(member);
        if (isAnyOf(node)) return visit(node.types);
        if (Array.isArray(value) && isEmptyClass(node)) {
          if (!taken) {
            taken = true;
            return [asGiven];
          }
          passed?.push(node);
          return [];
        }
        const sides = sidesOf(node, value);
        taken ||= sides.some(({ _tag }) => _tag !== "Void");
        return sides;
      });
  return visit(union.types);
};

/** The schemas of what these sides hold under one key. */
const typesAt = (
  sides: ReadonlyArray<Ast>,
  key: PropertyKey,
): ReadonlyArray<Ast> =>
  sides.flatMap((side) => {
    if (side._tag === "Arrays") {
      const index = arrayIndex(key);
      if (index === undefined) return [];
      const element = side.elements[index];
      return element === undefined ? side.rest : [element];
    }
    return side._tag === "Objects"
      ? [
          ...side.propertySignatures
            .filter(({ name }) => name === key)
            .map(({ type }) => type),
          ...side.indexSignatures.map(({ type }) => type),
        ]
      : [];
  });

/** The names on a schema's decoded side, which a value can use as well as the wire names. */
const decodedNames = (ast: Ast, value?: unknown): ReadonlyArray<string> =>
  ast._tag === "Union"
    ? ast.types
        .filter((member) => !ruledOut(member, value))
        .flatMap((member) => decodedNames(member, value))
    : ast._tag === "Suspend"
      ? decodedNames(ast.thunk(), value)
      : readsContainer(ast, value)
        ? fieldsOf(ast).map(({ name }) => String(name))
        : [];

/** Effect's empty struct has no shape checks on the keys of a supplied value. */
export const isSignaturelessObject = (ast: Ast): boolean =>
  ast._tag === "Objects" &&
  ast.propertySignatures.length === 0 &&
  ast.indexSignatures.length === 0;

/** Whether these sides read a value without any struct or list to take it apart, as an open schema. */
const readsOpaquely = (sides: ReadonlyArray<Ast>): boolean =>
  sides.some(
    ({ _tag }) =>
      _tag === "Any" || _tag === "Unknown" || _tag === "ObjectKeyword",
  ) || !sides.some(({ _tag }) => _tag === "Objects" || _tag === "Arrays");

/** Whether these sides leave a value's keys open, so none can be called unstated. */
const leaveKeysOpen = (sides: ReadonlyArray<Ast>): boolean =>
  readsOpaquely(sides) || sides.some(isSignaturelessObject);

/**
 * An empty struct keeps the value it reads as given, so it holds each key's value as given too, at
 * every depth: as an empty struct would read it again.
 */
const asGiven = Schema.Struct({}).ast;

/**
 * What these sides hold under one key: the schemas they state for it, and, beside an empty struct,
 * the value as given. An empty struct is then the member that keeps a key the others leave out, at
 * any depth, so that key is not unstated. With no stated schema nothing here can strip below the
 * key, so the empty struct's reading needs no walk through the value.
 */
const heldAt = (
  sides: ReadonlyArray<Ast>,
  key: PropertyKey,
): ReadonlyArray<Ast> => {
  const stated = typesAt(sides, key);
  return stated.length > 0 && sides.some(isSignaturelessObject)
    ? [...stated, asGiven]
    : stated;
};

/**
 * The names a struct here reads from a value although they are no keys of it, as an accessor on a
 * class is. A strict read only counts keys as excess, so it would strip such a field with no error.
 */
const unlisted = (
  sides: ReadonlyArray<Ast>,
  value: Record<PropertyKey, unknown>,
): ReadonlyArray<PropertyKey> =>
  Array.isArray(value)
    ? []
    : Array.from(
        new Set(sides.flatMap(fieldsOf).map(({ name }) => name)),
      ).filter(
        (name) =>
          name !== "__proto__" &&
          !Object.prototype.propertyIsEnumerable.call(value, name) &&
          value[name] !== undefined,
      );

/**
 * Whether only a struct can read a value here. A struct builds a plain object from any object, so a
 * class instance loses nothing by becoming one. A declaration may need the instance itself, so
 * there it keeps its keys, and stays an instance unless something in it has to change.
 */
const readAsStruct = (sides: ReadonlyArray<Ast>, open: boolean): boolean =>
  !open && !sides.some(({ _tag }) => _tag === "Declaration");

/**
 * Discover array layout only where no opaque reading can retain it untouched. An empty struct reads
 * a list too, but beside a list member a rewrite still has to keep every readable cell, hidden or
 * inherited, in place.
 */
const readAsArray = (sides: ReadonlyArray<Ast>): boolean =>
  sides.some(({ _tag }) => _tag === "Arrays") &&
  readAsStruct(sides, readsOpaquely(sides));

/** Bring a value's {@link unlisted} fields out as keys, at any depth, and take out what `drops` says. */
const rewriting = (drops: (item: unknown, stated: boolean) => boolean) => {
  const rewrite = (types: ReadonlyArray<Ast>, value: unknown): unknown => {
    if (types.length === 0 || !isObject(value)) return value;
    const sides = types.flatMap((type) => sidesOf(type, value));
    const hidden = unlisted(sides, value);
    const open = leaveKeysOpen(sides);
    const plain = isPlain(value);
    const asStruct = !plain && readAsStruct(sides, open);
    const asArray = readAsArray(sides);
    const isList = Array.isArray(value);
    const keys = [...keysOf(value, asArray), ...hidden];
    // Read each key once: a getter is the caller's code.
    const given = new Map<PropertyKey, unknown>();
    const entries = keys.flatMap((key) => {
      const item = value[key];
      given.set(key, item);
      const inner = heldAt(sides, key);
      return (plain || asStruct) &&
        !isList &&
        drops(item, open || inner.length > 0)
        ? []
        : [[key, rewrite(inner, item)] as const];
    });
    const same =
      !asStruct &&
      hidden.length === 0 &&
      entries.length === keys.length &&
      entries.every(([key, item]) => item === given.get(key));
    if (same) return value;
    if (!isList) return Object.fromEntries(entries);
    // Own-key inspection already reads this descriptor. Do not add a length getter read when an
    // enumerable child changes through a mixed opaque view, which may never read array layout.
    const length: unknown = asArray
      ? value.length
      : Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (
      typeof length !== "number" ||
      !Number.isInteger(length) ||
      length < 0 ||
      length > 0xffff_ffff
    )
      return value;
    // A proxy can report an own index beyond its length. A native array cannot retain both;
    // leave that incoherent frame to ordinary reading instead of manufacturing a larger view.
    if (
      entries.some(([key]) => {
        const index = arrayIndex(key);
        return index !== undefined && index >= length;
      })
    )
      return value;
    const output: Array<unknown> = [];
    output.length = length;
    for (const [key, item] of entries)
      Object.defineProperty(output, key, {
        value: item,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    if (!asArray) {
      // A view that does not read array layout still keeps every cell the caller supplied: an own
      // cell it did not rewrite keeps its descriptor, and an inherited one stays inherited.
      const rewritten = new Set(entries.map(([key]) => key));
      let positions = 0;
      for (const key of Reflect.ownKeys(value)) {
        const index = arrayIndex(key);
        if (index === undefined || index >= length) continue;
        positions++;
        if (!rewritten.has(key))
          Object.defineProperty(
            output,
            key,
            Object.getOwnPropertyDescriptor(value, key)!,
          );
      }
      // Own cells at every position leave no cell to inherit, so the prototype is not asked, which
      // a Proxy would observe. Where one is, a prototype that cannot be read leaves the list as it
      // was read before this kept inherited cells.
      if (positions < length) {
        let prototype: unknown = Array.prototype;
        try {
          prototype = Object.getPrototypeOf(value);
        } catch {
          // Keep the ordinary prototype.
        }
        if (prototype !== Array.prototype)
          Object.setPrototypeOf(output, prototype as object | null);
      }
    }
    return output;
  };
  return rewrite;
};

/**
 * What a caller means by a value, at any depth of plain objects and lists: no key set to `undefined`,
 * which holds nothing, and no key the schema does not state, which a struct would strip anyway. A
 * member a tag has ruled out states nothing. Returns `value` itself if there is nothing to change.
 */
export const normalised = rewriting(
  (item, stated) => item === undefined || !stated,
);

/** A value as the caller gave it, but for what {@link unlisted} brings out as keys. */
export const exposed = rewriting(() => false);

/** The fields of a group the caller gave and a schema states, under either of their names. */
export const statedFields = (
  ast: Ast,
  value: unknown,
): ReadonlyArray<PropertyKey> => {
  if (!isObject(value) || Array.isArray(value)) return [];
  const sides = sidesOf(ast, value);
  return [...keysOf(value), ...unlisted(sides, value)].filter(
    (key) => value[key] !== undefined && typesAt(sides, key).length > 0,
  );
};

const has = (value: unknown, key: PropertyKey): boolean =>
  isObject(value) && key in value && value[key] !== undefined;

const at = (value: unknown, key: PropertyKey): unknown =>
  isObject(value) ? value[key] : undefined;

/** Whether a value's keys mean something here: it is plain, or a struct here reads it. */
const comparable = (sides: ReadonlyArray<Ast>, value: object): boolean =>
  isPlain(value) || sides.some(({ _tag }) => _tag === "Objects");

/**
 * What a read lost from `given`, a {@link normalised} value, by comparing it with what came out. A
 * field has to be in the decoded value or in what was written. Under a name a member decodes, what
 * was written has to be what was given too, because that name can be another field's on the wire.
 * What this cannot see into, such as text or a `Map`, is left to the schema's own reading.
 */
export const missing = (
  types: ReadonlyArray<Ast>,
  given: unknown,
  value: unknown,
  output: unknown,
  path: Path = [],
  voidChoices?: WeakSet<Ast>,
): ReadonlyArray<Path> => {
  if (!isObject(given)) return [];
  const sides = types.flatMap((type) => sidesOf(type, given));
  if (!comparable(sides, given)) return [];
  const decoded = new Set(types.flatMap((type) => decodedNames(type, given)));
  const voidChoice = types.some((type) => voidChoices?.has(type));
  const holdsAsWritten = (key: PropertyKey) =>
    has(output, key) &&
    // A loose constructor can replace an encoded-only alias with a default after a strict Void
    // choice fails. Its output under that name does not show that the input was consumed.
    (!voidChoice || decoded.has(String(key))) &&
    (!isObject(value) ||
      !decoded.has(String(key)) ||
      Equal.equals(at(output, key), given[key]));
  return keysOf(given, readAsArray(sides)).flatMap((key) => {
    const here = [
      ...path,
      Array.isArray(given) ? (arrayIndex(key) ?? key) : key,
    ];
    return given[key] === undefined || has(value, key) || holdsAsWritten(key)
      ? missing(
          heldAt(sides, key),
          given[key],
          at(value, key),
          at(output, key),
          here,
          voidChoices,
        )
      : [here];
  });
};

const notHeld = new SchemaIssue.InvalidValue({
  message: "The schema cannot keep this field with the rest of the value",
});

/** A refusal that names the fields and, like any other schema failure here, leaves out values. */
export const refusal = (
  ast: Ast,
  [first, ...others]: readonly [Path, ...ReadonlyArray<Path>],
): Schema.SchemaError =>
  new Schema.SchemaError(
    new SchemaIssue.Composite(ast, [
      new SchemaIssue.Pointer(first, notHeld),
      ...others.map((path) => new SchemaIssue.Pointer(path, notHeld)),
    ]),
  );

/** Whether a schema holds a choice of member, which only a stacked schema can settle for it. */
export const choosesMember = holding(isMemberChoice);

/**
 * Whether a schema holds a choice that can cost a field, of member or of side, anywhere it can be
 * seen, apart from the separate Void rule. `Schema.NullOr` around a struct has no such choice.
 */
export const choosing = holding(
  (ast) => isMemberChoice(ast) || isSideChoice(ast),
);

/** A step Effect reads a value through without this seeing its keys, so it may keep them all. */
/**
 * Whether a schema holds middleware, which can turn a refusal into a value that holds none of the
 * caller's fields. Ask it once a value is read, through {@link lazily}.
 */
export const recovers = holdingResolved((ast) =>
  (ast.encoding ?? []).some(
    ({ transformation }) => transformation._tag === "Middleware",
  ),
);

/** Whether a schema holds an empty class. Ask it once a value is read, through {@link lazily}. */
export const holdsEmptyClass = holdingResolved(isEmptyClass);

/** Whether a member these schemas offer at a value has middleware, through groups and suspensions. */
const offersRecovery = (types: ReadonlyArray<Ast>): boolean => {
  const seen = new Set<Ast>();
  const offers = (ast: Ast): boolean => {
    const node = resolved(ast);
    if (seen.has(node)) return false;
    seen.add(node);
    return (
      recoversHere(node) || (node._tag === "Union" && node.types.some(offers))
    );
  };
  return types.some(offers);
};

/**
 * The cells of a caller's list a reading lost where middleware could take that list. Middleware that
 * takes a list keeps its cells, or the request is refused; for any other value it gives its own
 * reading, as Effect's does. This follows only the schemas stated for a value, so it reads nothing
 * that an opaque or open schema holds.
 */
export const lostCells = (
  types: ReadonlyArray<Ast>,
  given: unknown,
  value: unknown,
  output: unknown,
  path: Path = [],
): ReadonlyArray<Path> => {
  if (types.length === 0 || !isObject(given)) return [];
  if (Array.isArray(given) && offersRecovery(types))
    return keysOf(given).flatMap((key) => {
      const index = arrayIndex(key);
      return index === undefined ||
        given[key] === undefined ||
        has(value, key) ||
        has(output, key)
        ? []
        : [[...path, index]];
    });
  const sides = types.flatMap((type) => sidesOf(type, given));
  return keysOf(given, readAsArray(sides)).flatMap((key) => {
    const inner = heldAt(sides, key);
    return inner.length === 0
      ? []
      : lostCells(inner, given[key], at(value, key), at(output, key), [
          ...path,
          Array.isArray(given) ? (arrayIndex(key) ?? key) : key,
        ]);
  });
};

/** Whether a union these schemas offer at a list has an empty class after another list reader. */
const passesClass = (types: ReadonlyArray<Ast>, list: unknown): boolean => {
  const passed: Array<Ast> = [];
  for (const type of types) {
    const node = resolved(type);
    if (node._tag === "Union") membersOf(node, list, passed);
  }
  return passed.length > 0;
};

/** A copy of an output this module made, with the same prototype, which can take a changed key. */
const copied = (output: Record<PropertyKey, unknown>) =>
  Array.isArray(output)
    ? output.slice()
    : Object.defineProperties(
        Object.create(Object.getPrototypeOf(output) as object | null),
        Object.getOwnPropertyDescriptors(output),
      );

/**
 * A reading's output with the caller's cells given back to an empty class that took a list after
 * another member that reads lists refused it. The class read the cells that member's reading cut, so
 * its copy gets the caller's, at that list only; nothing is read again. This follows only the
 * schemas stated for a value, so it reads nothing that an opaque or open schema holds.
 */
export const restoredCells = (
  types: ReadonlyArray<Ast>,
  given: unknown,
  input: unknown,
  output: unknown,
): unknown => {
  if (types.length === 0 || !isObject(given) || !isObject(output))
    return output;
  if (Array.isArray(given) && !Array.isArray(output)) {
    if (!Array.isArray(input) || !passesClass(types, given)) return output;
    const cells = input as unknown as Record<PropertyKey, unknown>;
    const copy = copied(output);
    for (const key of keysOf(cells))
      if (arrayIndex(key) !== undefined && Object.hasOwn(copy, key))
        copy[key] = cells[key];
    return copy;
  }
  const sides = types.flatMap((type) => sidesOf(type, given));
  let copy: Record<PropertyKey, unknown> | undefined;
  for (const key of keysOf(given, readAsArray(sides))) {
    const inner = heldAt(sides, key);
    if (inner.length === 0) continue;
    const before = at(output, key);
    const after = restoredCells(inner, given[key], at(input, key), before);
    if (after !== before) (copy ??= copied(output))[key] = after;
  }
  return copy ?? output;
};

/** What a writer writes as given. A value it leaves out or replaces fails this. */
export type Carries = (value: unknown) => boolean;

/** Whether these sides mix an empty struct with a struct or list that states what it reads. */
const mixesEmpty = (sides: ReadonlyArray<Ast>): boolean =>
  sides.some(isSignaturelessObject) &&
  sides.some(
    (side) =>
      side._tag === "Arrays" ||
      (side._tag === "Objects" && !isSignaturelessObject(side)),
  );

/** The nodes a union's members and their encodings show, through suspended members. */
const shownSides = (ast: Ast, seen = new Set<Ast>()): ReadonlyArray<Ast> => {
  if (seen.has(ast)) return [];
  seen.add(ast);
  return ast._tag === "Union"
    ? ast.types.flatMap((member) => shownSides(member, seen))
    : ast._tag === "Suspend"
      ? shownSides(ast.thunk(), seen)
      : [
          ast,
          ...(ast.encoding ?? []).flatMap(({ to }) => shownSides(to, seen)),
        ];
};

/**
 * Whether a schema can hold an empty struct beside a stated struct or list, as a union can. Ask it
 * once a value is read, through {@link lazily}, since it resolves suspended schemas.
 */
export const mixes = holdingResolved(
  (ast) => ast._tag === "Union" && mixesEmpty(shownSides(ast)),
);

/** A list or an ordinary object, which a writer takes apart; any other object it writes whole. */
const isContainer = (value: unknown): value is Record<PropertyKey, unknown> =>
  isObject(value) &&
  (Array.isArray(value) ||
    [Object.prototype, null].includes(Object.getPrototypeOf(value)));

/**
 * The fields an empty struct beside a stated member would hand a writer that cannot write them as
 * given: a symbol key, which no writer carries, or a value `carries` refuses. Where the stated
 * member wins, its encoding already wrote its fields for the wire. Where the empty struct wins, the
 * caller's values go out as given, and a writer that leaves one out or replaces it, as JSON writes
 * `NaN` as `null`, would lose that field silently. An empty struct alone keeps its own reading.
 */
export const uncarried = (
  types: ReadonlyArray<Ast>,
  output: unknown,
  carries: Carries,
  path: Path = [],
): ReadonlyArray<Path> => {
  if (!isObject(output)) return [];
  const sides = types.flatMap((type) => sidesOf(type, output));
  const mixed = mixesEmpty(sides);
  const list = Array.isArray(output);
  return Reflect.ownKeys(output).flatMap((key) => {
    // A list's other keys are metadata, which no writer reads as a cell.
    if (
      !Object.prototype.propertyIsEnumerable.call(output, key) ||
      (list && arrayIndex(key) === undefined)
    )
      return [];
    const item = output[key];
    if (item === undefined) return [];
    const here = [...path, list ? (arrayIndex(key) ?? key) : key];
    if (mixed && typeof key === "symbol") return [here];
    const inner = heldAt(sides, key);
    if (mixed && (typesAt(sides, key).length === 0 || !isContainer(item)))
      return carries(item) ? [] : [here];
    return inner.length > 0 ? uncarried(inner, item, carries, here) : [];
  });
};

/**
 * JSON writes finite numbers, text, booleans, null and plain lists and objects of those, as
 * Effect's JSON codec requires of an `Unknown` value. `undefined` holds nothing, so it is no field.
 */
export const carriesJson: Carries = (value) => {
  const visiting = new Set<object>();
  const carried = (item: unknown): boolean => {
    if (
      item === null ||
      item === undefined ||
      typeof item === "string" ||
      typeof item === "boolean"
    )
      return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (!isContainer(item) || visiting.has(item)) return false;
    visiting.add(item);
    const keys = Reflect.ownKeys(item).filter((key) =>
      Object.prototype.propertyIsEnumerable.call(item, key),
    );
    const ok = Array.isArray(item)
      ? keys.every((key) => arrayIndex(key) === undefined || carried(item[key]))
      : keys.every((key) => typeof key === "string" && carried(item[key]));
    visiting.delete(item);
    return ok;
  };
  return carried(value);
};

const isQueryScalar = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  value instanceof Date ||
  ["string", "number", "bigint", "boolean"].includes(typeof value);

/** A query writes `UrlEncoding.QueryValue` text, or a list of such values, under one name. */
export const carriesQuery: Carries = (value) =>
  isQueryScalar(value) ||
  (Array.isArray(value) &&
    Array.prototype.every.call(value, (item: unknown) => isQueryScalar(item)));

/** A header check of its own refuses any value that is not text, so only a symbol key is lost. */
export const carriesHeader: Carries = () => true;
