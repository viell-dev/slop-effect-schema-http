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

/**
 * A struct, record, list or tuple, alone or decoded from one of the same kind through plain
 * transformations, as `Schema.encodeKeys` builds a struct. Effect's parser tells containers apart
 * for these by `Array.isArray` alone. Field types can be anything: each child value is judged at its
 * own level.
 */
const isStructural = (ast: Ast): boolean =>
  (ast._tag === "Objects" || ast._tag === "Arrays") &&
  (ast.encoding ?? []).every(
    ({ transformation, to }) =>
      transformation._tag === "Transformation" &&
      to._tag === ast._tag &&
      isStructural(to),
  );

/**
 * An alternative Effect's parser refuses any object for, as text, a number or `null` is, also
 * through plain transformations between such schemas, as `Schema.FiniteFromString` is.
 */
const takesNoObject = (ast: Ast): boolean =>
  (ast._tag === "Union"
    ? ast.types.every(takesNoObject)
    : stageRefuses(ast, "record") && stageRefuses(ast, "array")) &&
  (ast.encoding ?? []).every(
    ({ transformation, to }) =>
      transformation._tag === "Transformation" && takesNoObject(to),
  );

const knownNodes = new WeakMap<Ast, boolean>();

/**
 * Whether what this one alternative reads from an object or a list is known from the schema alone:
 * it is {@link isStructural}, it {@link takesNoObject}, or it is built-in `Schema.Void`, which the
 * Void rule decides. A class, a declaration, an open schema, middleware and any other codec are not.
 */
const isKnown = (ast: Ast): boolean => {
  let known = knownNodes.get(ast);
  if (known === undefined) {
    known =
      isStructural(ast) ||
      takesNoObject(ast) ||
      (ast._tag === "Void" && ast.encoding === undefined);
    knownNodes.set(ast, known);
  }
  return known;
};

/**
 * Whether this one side can read a value of this kind of container, as Effect's parser tells them
 * apart: a record or a struct that states a field refuses an actual array, and an array or tuple
 * refuses any other object.
 */
const readsContainer = (side: Ast, value: unknown): boolean =>
  !isObject(value) ||
  !stageRefuses(side, Array.isArray(value) ? "array" : "record");

/**
 * The sides a value is read against here, and whether its alternatives are all {@link isKnown} with
 * no middleware reading it or a value around it. Only then do the rules this library adds apply at
 * the value: a side that cannot read the value's container holds none of its keys, wherever in a
 * union or under whichever parent it comes from, and an empty struct holds every key it reads.
 * Anywhere else the value keeps the reading these had before those rules, side for side. Each child
 * value is judged again at its own level.
 */
interface View {
  readonly sides: ReadonlyArray<Ast>;
  readonly known: boolean;
  /** Whether an empty struct holds each key here as given, at any depth below it. */
  readonly holdsAsGiven: boolean;
  /**
   * Whether middleware reads this value. Its recovery can turn a failure anywhere inside into a
   * value of its own, so what the value holds below is not known either.
   */
  readonly recovers: boolean;
}

interface Collected {
  readonly sides: Array<Ast>;
  recovers: boolean;
}

/**
 * The schemas a value can be read against here, pushed into `sides`: each member its tag leaves,
 * through unions and suspended schemas, as Effect reads them at this value, and each node's encoding
 * sides after it. Returns whether this alternative is {@link isKnown}. A union or a suspension with
 * an encoding of its own is a codec, so it is judged as one node.
 */
const collect = (ast: Ast, value: unknown, into: Collected): boolean => {
  let known: boolean;
  if (ast._tag === "Union") {
    known = true;
    for (const member of ast.types)
      if (!ruledOut(member, value))
        known = collect(member, value, into) && known;
    if (ast.encoding !== undefined) known = isKnown(ast);
  } else if (ast._tag === "Suspend") {
    known = collect(ast.thunk(), value, into) && ast.encoding === undefined;
  } else {
    into.sides.push(ast);
    known = isKnown(ast);
  }
  for (const { to, transformation } of ast.encoding ?? []) {
    if (transformation._tag === "Middleware") into.recovers = true;
    collect(to, value, into);
  }
  return known;
};

/** {@link View} of a value, inside a value middleware reads when `recovering` is set. */
const viewAt = (
  types: ReadonlyArray<Ast>,
  value: unknown,
  recovering = false,
): View => {
  const into: Collected = { sides: [], recovers: recovering };
  let known = isObject(value);
  for (const type of types) known = collect(type, value, into) && known;
  const { sides, recovers } = into;
  if (!known || recovers)
    return { sides, known: false, holdsAsGiven: false, recovers };
  const read = sides.filter((side) => readsContainer(side, value));
  return {
    sides: read,
    known,
    holdsAsGiven: read.some(isSignaturelessObject),
    recovers,
  };
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

/**
 * The names on a schema's decoded side, which a value can use as well as the wire names. Where the
 * value's alternatives are {@link isKnown}, a side that cannot read its container names none.
 */
const decodedNames = (
  ast: Ast,
  value: unknown,
  known: boolean,
): ReadonlyArray<string> =>
  ast._tag === "Union"
    ? ast.types
        .filter((member) => !ruledOut(member, value))
        .flatMap((member) => decodedNames(member, value, known))
    : ast._tag === "Suspend"
      ? decodedNames(ast.thunk(), value, known)
      : !known || readsContainer(ast, value)
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

/**
 * Whether a value's keys are open here, so none can be called unstated: an open schema reads it, or
 * its alternatives are {@link isKnown} and an empty struct is among them.
 */
const leaveKeysOpen = ({ sides, holdsAsGiven }: View): boolean =>
  holdsAsGiven || readsOpaquely(sides);

/**
 * Whether no side states a key here, as before an empty struct held every key: then an empty struct
 * keeps the keys it reads.
 */
const statesNothing = (sides: ReadonlyArray<Ast>): boolean =>
  sides.some(isSignaturelessObject) &&
  !sides.some(
    (side) => side._tag === "Objects" && !isSignaturelessObject(side),
  );

/**
 * An empty struct keeps the value it reads as given, so it holds each key's value as given too, at
 * every depth: as an empty struct would read it again.
 */
const asGiven = Schema.Struct({}).ast;

/**
 * What these sides hold under one key: the schemas they state for it, and, where the value's
 * alternatives are {@link isKnown}, beside an empty struct, the value as given. An empty struct is
 * then the member that keeps a key the others leave out, at any depth, so that key is not unstated.
 * With no stated schema nothing here can strip below the key, so the empty struct's reading needs
 * no walk through the value.
 */
const heldAt = (
  { sides, holdsAsGiven }: View,
  key: PropertyKey,
): ReadonlyArray<Ast> => {
  const stated = typesAt(sides, key);
  return holdsAsGiven && stated.length > 0 ? [...stated, asGiven] : stated;
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
  const rewrite = (
    types: ReadonlyArray<Ast>,
    value: unknown,
    recovering: boolean,
  ): unknown => {
    if (types.length === 0 || !isObject(value)) return value;
    const view = viewAt(types, value, recovering);
    const { sides } = view;
    const hidden = unlisted(sides, value);
    const open = leaveKeysOpen(view);
    const keepKeys = open || statesNothing(sides);
    const plain = isPlain(value);
    const asStruct = !plain && readAsStruct(sides, open);
    const asArray = readAsArray(sides);
    const isList = Array.isArray(value);
    const keys = [...keysOf(value, asArray), ...hidden];
    // Read each key once: a getter is the caller's code.
    let changed = asStruct || hidden.length > 0;
    const entries = keys.flatMap((key) => {
      const item = value[key];
      const inner = heldAt(view, key);
      if (
        (plain || asStruct) &&
        !isList &&
        drops(item, keepKeys || inner.length > 0)
      ) {
        changed = true;
        return [];
      }
      const next = rewrite(inner, item, view.recovers);
      changed ||= next !== item;
      return [[key, next] as const];
    });
    if (!changed) return value;
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
  return (types: ReadonlyArray<Ast>, value: unknown): unknown =>
    rewrite(types, value, false);
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
  const { sides } = viewAt([ast], value);
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
  recovering = false,
): ReadonlyArray<Path> => {
  if (!isObject(given)) return [];
  const view = viewAt(types, given, recovering);
  const { sides } = view;
  if (!comparable(sides, given)) return [];
  const decoded = new Set(
    types.flatMap((type) => decodedNames(type, given, view.known)),
  );
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
          heldAt(view, key),
          given[key],
          at(value, key),
          at(output, key),
          here,
          voidChoices,
          view.recovers,
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
  recovering = false,
): ReadonlyArray<Path> => {
  if (!isObject(output)) return [];
  const view = viewAt(types, output, recovering);
  const { sides } = view;
  // Only where the value's alternatives are known does an empty struct keep what it holds.
  const mixed = view.known && mixesEmpty(sides);
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
    const inner = heldAt(view, key);
    if (mixed && (typesAt(sides, key).length === 0 || !isContainer(item)))
      return carries(item) ? [] : [here];
    return inner.length > 0
      ? uncarried(inner, item, carries, here, view.recovers)
      : [];
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
