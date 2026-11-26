import { Equal, Option, Schema, SchemaAST, SchemaIssue } from "effect";
import { stateOf } from "./object-brand.js";
import { isPlainData, statesPrototypeName } from "./plain.js";
import { extraArrayField } from "./writer-error.js";
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

/** A Void, or a group of members with one, which Effect lets take any object. */
const takesAnything = (ast: Ast): boolean =>
  ast._tag === "Void" ||
  (ast._tag === "Union" && ast.types.some(takesAnything));

/** A union between members that can read an object's keys, or of one and a Void. */
const isObjectUnion = (ast: Ast): boolean => {
  if (ast._tag !== "Union") return false;
  const reading = ast.types.filter(readsKeys).length;
  return reading > 1 || (reading === 1 && ast.types.some(takesAnything));
};

/** A choice of member: a union between objects, or a suspended schema, which may not exist yet. */
const isMemberChoice = (ast: Ast): boolean =>
  ast._tag === "Suspend" || isObjectUnion(ast);

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

/**
 * Whether an object holds content outside its own fields, as a `Map` does, which an object rebuilt
 * from them loses. A typed array and a boxed string hold theirs at enumerable positions. An instance
 * with no fields that writes itself with `toJSON`, as a `URL` does, holds all of it elsewhere.
 */
export const hasHiddenContent = (value: object): boolean => {
  if (isPlain(value)) return false;
  const state = stateOf(value, Reflect.ownKeys(value).length === 0);
  if (state !== undefined)
    return (
      state !== "String" && (state === "DataView" || !ArrayBuffer.isView(value))
    );
  return (
    Object.keys(value).length === 0 &&
    typeof (value as { readonly toJSON?: unknown }).toJSON === "function"
  );
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

/** A value's own keys with their descriptors, each read once, in the order the value gives them. */
interface OwnDescriptors {
  readonly keys: ReadonlyArray<PropertyKey>;
  /** The descriptor of each key, at its index in `keys`. */
  readonly descriptors: ReadonlyArray<PropertyDescriptor | undefined>;
}

const ownDescriptors = (value: object): OwnDescriptors => {
  const keys = Reflect.ownKeys(value);
  return {
    keys,
    descriptors: keys.map((key) => Object.getOwnPropertyDescriptor(value, key)),
  };
};

/**
 * The keys a value supplies, and with `arrays`, a list's hidden and inherited cells. `descriptors`
 * are its own keys as {@link ownDescriptors} already read them, so a Proxy is not asked again.
 */
const keysOf = (
  value: object,
  arrays = false,
  descriptors?: OwnDescriptors,
): ReadonlyArray<PropertyKey> => {
  const list = arrays && Array.isArray(value);
  const length = list ? value.length : 0;
  const own = descriptors?.keys ?? Reflect.ownKeys(value);
  const enumerable = (key: PropertyKey, index: number) =>
    descriptors === undefined
      ? Object.prototype.propertyIsEnumerable.call(value, key)
      : descriptors.descriptors[index]?.enumerable === true;
  const keys = new Set(
    own.filter(
      (key, index) =>
        enumerable(key, index) || (list && arrayIndex(key) !== undefined),
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
 * A struct decoded from a struct of the same shape through any single plain transformation, as
 * `Schema.encodeKeys` builds one: one plain link to an unchecked struct with no encoding of its
 * own, holding as many fields in the same order, each with the same optionality and the encoded
 * form of the same type. The key names and what the transformation does with the fields are not
 * inspected.
 */
const isKeyRename = (ast: SchemaAST.Objects): boolean => {
  const [link, ...others] = ast.encoding ?? [];
  return link !== undefined && others.length === 0 && renamesKeys(ast, link);
};

/** Whether a link leads from a struct to one of the same shape, as {@link isKeyRename} describes. */
const renamesKeys = (
  from: SchemaAST.Objects,
  { to, transformation }: SchemaAST.Link,
): boolean =>
  transformation._tag === "Transformation" &&
  to._tag === "Objects" &&
  to.encoding === undefined &&
  to.checks === undefined &&
  from.indexSignatures.length === 0 &&
  to.indexSignatures.length === 0 &&
  to.propertySignatures.length === from.propertySignatures.length &&
  from.propertySignatures.every(({ type }, index) => {
    const encoded = to.propertySignatures[index]!.type;
    return (
      SchemaAST.isOptional(type) === SchemaAST.isOptional(encoded) &&
      SchemaAST.toEncoded(type) === encoded
    );
  });

/**
 * A struct, record, list or tuple, or a struct decoded from a same-shaped struct through any single
 * plain transformation, as {@link isKeyRename} accepts, such as `Schema.encodeKeys`. Effect's parser
 * tells containers apart for these by `Array.isArray` alone. Field types can be anything: each child
 * value is judged at its own level.
 */
const isStructural = (ast: Ast): boolean =>
  (ast._tag === "Objects" || ast._tag === "Arrays") &&
  (ast.encoding === undefined || (ast._tag === "Objects" && isKeyRename(ast)));

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

/** A class that states fields, which reads what its struct does, and no list. */
const isStatedClass = (ast: Ast): boolean => {
  const fields = classFields(ast);
  return (
    fields !== undefined &&
    ast.encoding!.length === 1 &&
    ast.encoding![0].transformation._tag === "Transformation" &&
    fieldsOf(fields).length > 0
  );
};

const knownNodes = new WeakMap<Ast, boolean>();

/**
 * Whether what this one alternative reads from an object or a list is known from the schema alone:
 * it is {@link isStructural} or it {@link takesNoObject}. A class, a declaration, an open schema,
 * middleware and any other codec are not. Built-in `Schema.Void` is, as it never reads an object or a
 * list that holds something, which {@link collect} decides.
 */
const isKnown = (ast: Ast): boolean => {
  let known = knownNodes.get(ast);
  if (known === undefined) {
    known = isStructural(ast) || isStatedClass(ast) || takesNoObject(ast);
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
 * The sides a value is read against here, and whether its alternatives are all known, with no
 * middleware reading it and no value around it keeping the earlier reading. Only then do the rules
 * this library adds apply at the value: a side that cannot read the value's container holds none of
 * its keys, wherever in a union or under whichever parent it comes from, and an empty struct holds
 * every key it reads. Anywhere else the value keeps the reading these had before those rules, side
 * for side, and so does every value inside it: an alternative that is not known, such as a class,
 * can take the whole value, and middleware can turn a failure anywhere inside into a value of its
 * own. An open schema, or an empty struct around the value, still holds every key there.
 */
interface View {
  readonly sides: ReadonlyArray<Ast>;
  readonly known: boolean;
  /** Whether middleware reads the value or one around it, and so could replace it. */
  readonly recovers: boolean;
  /**
   * Whether an empty struct or an open schema, among the alternatives or around the value, holds each
   * key here as given, at any depth.
   */
  readonly holdsAsGiven: boolean;
}

interface Collected {
  readonly sides: Array<Ast>;
  recovers: boolean;
  holds: boolean;
}

const collected = (): Collected => ({
  sides: [],
  recovers: false,
  holds: false,
});

/**
 * Whether an alternative keeps every key of a value it reads: an empty struct, an open schema, or an
 * empty class of an object. A list is not left to a class, which would make an object of it.
 */
const holdsEveryKey = (ast: Ast, value: unknown): boolean => {
  if (ast.encoding === undefined)
    return (
      isSignaturelessObject(ast) || (isOpen(ast) && ast.checks === undefined)
    );
  const fields = classFields(ast);
  return (
    fields !== undefined &&
    ast.encoding.length === 1 &&
    isSignaturelessObject(fields) &&
    !Array.isArray(value)
  );
};

/**
 * The schemas a value can be read against here, pushed into `sides`: each member its tag leaves,
 * through unions and suspended schemas, as Effect reads them at this value, and each node's encoding
 * sides after it. Returns whether this alternative is known. A union or a suspension with an
 * encoding of its own is a codec, so it is judged as one node.
 *
 * A member a tag rules out states nothing, so it adds no side, but it is still an alternative: its
 * middleware runs because the value does not fit it. An empty struct or an open schema holds the keys
 * it reads only as an alternative of its own, not as one end of a codec, and an open schema with a
 * check of its own may refuse the value, so it holds nothing for certain.
 */
const collect = (
  ast: Ast,
  value: unknown,
  into: Collected,
  end = false,
): boolean => {
  let known: boolean;
  if (ast._tag === "Union") {
    known = true;
    for (const member of ast.types) {
      const target = ruledOut(member, value) ? collected() : into;
      known = collect(member, value, target, end) && known;
      if (target.recovers) into.recovers = true;
    }
    if (ast.encoding !== undefined) known = isKnown(ast);
  } else if (ast._tag === "Suspend") {
    known =
      collect(ast.thunk(), value, into, end) && ast.encoding === undefined;
  } else {
    into.sides.push(ast);
    known = ast._tag === "Void" ? ast.encoding === undefined : isKnown(ast);
    if (!end && holdsEveryKey(ast, value)) into.holds = true;
  }
  for (const { to, transformation } of ast.encoding ?? []) {
    if (transformation._tag === "Middleware") into.recovers = true;
    collect(to, value, into, true);
  }
  return known;
};

/** The {@link View} of a value that keeps the earlier reading. */
const earlierView = ({ sides, holds, recovers }: Collected): View => {
  // An empty struct a parent holds a key with is no side of the earlier reading, but it still holds
  // what is below. Where middleware could take a value with a key no other member states, it does not.
  const held = sides.includes(asGiven);
  return {
    sides: held ? sides.filter((side) => side !== asGiven) : sides,
    known: false,
    recovers,
    holdsAsGiven: holds && !recovers,
  };
};

/**
 * Whether the container rule leaves a value's fields to the Void: a side it removed states one of
 * the value's defined fields, and no side left states any. Then nothing left holds
 * what the earlier reading kept: normalization strips those fields, or, with no struct or list side
 * left, nothing stands between the value and the Void.
 */
const leavesToVoid = (
  kept: ReadonlyArray<Ast>,
  removed: ReadonlyArray<Ast>,
  value: Record<PropertyKey, unknown>,
): boolean => {
  let held = false;
  for (const key of Reflect.ownKeys(value)) {
    const field = Array.isArray(value)
      ? arrayIndex(key) !== undefined
      : Object.prototype.propertyIsEnumerable.call(value, key);
    if (!field || value[key] === undefined) continue;
    if (typesAt(kept, key).length > 0) return false;
    held ||= typesAt(removed, key).length > 0;
  }
  return held;
};

/** The {@link View} of a value inside another, which keeps the earlier reading where that one does. */
const viewAt = (
  types: ReadonlyArray<Ast>,
  value: unknown,
  within?: View,
): View => {
  const into = collected();
  if (within?.recovers === true) into.recovers = true;
  let known = isObject(value);
  for (const type of types) known = collect(type, value, into) && known;
  if (!known || within?.known === false || into.recovers)
    return earlierView(into);
  const sides = into.sides.filter((side) => readsContainer(side, value));
  // Beside a Void, a side the container rule leaves out may be the only one stating the caller's
  // fields. Leaving them all unstated would let the Void take the whole value where the earlier
  // reading refuses it, so such a value keeps that reading.
  if (
    sides.length < into.sides.length &&
    !into.holds &&
    into.sides.some(({ _tag }) => _tag === "Void") &&
    leavesToVoid(
      sides,
      into.sides.filter((side) => !sides.includes(side)),
      value as Record<PropertyKey, unknown>,
    )
  )
    return earlierView(into);
  return {
    sides,
    known,
    recovers: false,
    holdsAsGiven: into.holds,
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

/** A schema that reads any object as it is. */
const isOpen = ({ _tag }: Ast): boolean =>
  _tag === "Any" || _tag === "Unknown" || _tag === "ObjectKeyword";

/** Whether these sides read a value without any struct or list to take it apart, as an open schema. */
const readsOpaquely = (sides: ReadonlyArray<Ast>): boolean =>
  sides.some(isOpen) ||
  !sides.some(({ _tag }) => _tag === "Objects" || _tag === "Arrays");

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
 * Whether an instance beside an empty struct reads as a struct does, because it holds a key set to
 * `undefined` and otherwise only fields the other members state. Such a key holds nothing, so it may
 * not push the instance out of those members, nor leave it to a Void. The empty struct keeps any
 * other instance as given, and one whose content is not in its own fields, as a `Map` is.
 */
const meansStated = (
  { sides, holdsAsGiven }: View,
  value: object,
  keys: ReadonlyArray<PropertyKey>,
  items: ReadonlyArray<unknown>,
): boolean =>
  holdsAsGiven &&
  items.includes(undefined) &&
  sides.some(
    (side) => side._tag === "Objects" && !isSignaturelessObject(side),
  ) &&
  keys.every(
    (key, index) =>
      items[index] === undefined || typesAt(sides, key).length > 0,
  ) &&
  stateOf(value, true) === undefined;

/**
 * Discover array layout only where no opaque reading can retain it untouched. An empty struct reads
 * a list too, but beside a list member a rewrite still has to keep every readable cell, hidden or
 * inherited, in place.
 */
const readAsArray = (sides: ReadonlyArray<Ast>): boolean =>
  sides.some(({ _tag }) => _tag === "Arrays") &&
  readAsStruct(sides, readsOpaquely(sides));

type Renamed = ReadonlyArray<ReadonlyMap<PropertyKey, Ast>>;

const renamings = new WeakMap<Ast, Renamed>();

/**
 * The fields a schema reads from names it writes: each name a key rename writes, with the schema of
 * the field written there. Below such a name a caller can give either side of that field.
 */
const renamedFields = (ast: Ast): Renamed => {
  let renamed = renamings.get(ast);
  if (renamed === undefined) {
    renamed =
      ast._tag === "Union"
        ? ast.types.flatMap(renamedFields)
        : ast._tag === "Suspend"
          ? renamedFields(ast.thunk())
          : ast._tag === "Objects" && isKeyRename(ast)
            ? [
                new Map(
                  fieldsOf(ast.encoding![0].to).map(({ name }, index) => [
                    name,
                    ast.propertySignatures[index]!.type,
                  ]),
                ),
              ]
            : [];
    renamings.set(ast, renamed);
  }
  return renamed;
};

/** Bring a value's {@link unlisted} fields out as keys, at any depth, and take out what `drops` says. */
const rewriting = (drops: (item: unknown, stated: boolean) => boolean) => {
  const rewrite = (
    types: ReadonlyArray<Ast>,
    value: unknown,
    within: View | undefined,
    /** Field schemas that also state names here, as their decoded side does below a written name. */
    also: ReadonlyArray<Ast> = [],
  ): unknown => {
    if (types.length === 0 || !isObject(value)) return value;
    const view = viewAt(types, value, within);
    const { sides } = view;
    const hidden = unlisted(sides, value);
    const open = leaveKeysOpen(view);
    const keepKeys = open || statesNothing(sides);
    const alsoSides = also.length === 0 ? [] : viewAt(also, value).sides;
    const renamed =
      types.length === 1
        ? renamedFields(types[0]!)
        : types.flatMap(renamedFields);
    const beyond = alsoSides.length > 0 || renamed.length > 0;
    const plain = isPlain(value);
    const asArray = readAsArray(sides);
    const isList = Array.isArray(value);
    // A list rebuilt in a view that does not read its layout copies its own cells' descriptors, so
    // read them once here, for the keys too.
    const own = isList && !asArray ? ownDescriptors(value) : undefined;
    const keys = [...keysOf(value, asArray, own), ...hidden];
    // Read each key once: a getter is the caller's code.
    const items =
      !plain && view.holdsAsGiven ? keys.map((key) => value[key]) : undefined;
    const asStruct =
      !plain &&
      // A record could hold any field and a Void takes what holds none, so what this copy would leave
      // out has to stay in sight.
      !(
        sides.some((side) => isIndexed(side) || side._tag === "Void") &&
        hasHiddenContent(value)
      ) &&
      (readAsStruct(sides, open) ||
        (items !== undefined && meansStated(view, value, keys, items)));
    let changed = asStruct || hidden.length > 0;
    const entries = keys.flatMap((key, index) => {
      const item = items === undefined ? value[key] : items[index];
      const inner = heldAt(view, key);
      if (
        (plain || asStruct) &&
        !isList &&
        drops(
          item,
          keepKeys ||
            inner.length > 0 ||
            (beyond && typesAt(alsoSides, key).length > 0),
        )
      ) {
        changed = true;
        return [];
      }
      const next = rewrite(
        inner,
        item,
        view,
        beyond && isObject(item)
          ? [
              ...typesAt(alsoSides, key),
              ...renamed.flatMap((fields) => fields.get(key) ?? []),
            ]
          : undefined,
      );
      changed ||= next !== item;
      return [[key, next] as const];
    });
    if (!changed) return value;
    if (!isList) return Object.fromEntries(entries);
    // Own-key inspection already read this descriptor. Do not add a length getter read when an
    // enumerable child changes through a mixed opaque view, which may never read array layout.
    const length: unknown =
      own === undefined
        ? value.length
        : (own.descriptors[own.keys.lastIndexOf("length")]?.value as unknown);
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
    if (own !== undefined) {
      // A view that does not read array layout still keeps every cell the caller supplied: an own
      // cell it did not rewrite keeps its descriptor, and an inherited one stays inherited.
      const rewritten = new Set(entries.map(([key]) => key));
      let positions = 0;
      for (const [at, key] of own.keys.entries()) {
        const descriptor = own.descriptors[at];
        const index = arrayIndex(key);
        if (index === undefined || index >= length || descriptor === undefined)
          continue;
        positions++;
        if (!rewritten.has(key)) Object.defineProperty(output, key, descriptor);
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
    rewrite(types, value, undefined);
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

/** A field's name as a struct reads it, and the name it is written under. */
type Naming = readonly [read: PropertyKey, written: PropertyKey];

/**
 * Whether a struct writes a record key only as a value holds it: no index signature has a key schema
 * with an encoding, which could write a key under any name.
 */
const writesHeldKeys = ({ indexSignatures }: SchemaAST.Objects): boolean =>
  indexSignatures.every(
    ({ parameter }) => SchemaAST.toEncoded(parameter) === parameter,
  );

/**
 * Whether a struct renamed to these names states its fields in the order they were renamed. An
 * object lists index names first and symbols last, so `Schema.encodeKeys` onto such a name can state
 * the encoded fields in another order than the decoded ones, and position no longer pairs them.
 */
const keepsOrder = ({ propertySignatures }: SchemaAST.Objects): boolean =>
  propertySignatures.every(
    ({ name }) => typeof name === "string" && arrayIndex(name) === undefined,
  );

/**
 * The name each of a struct's fields is written under through these links, by position. Each link
 * has to lead to a struct of the same shape, onto names that keep their order, and no record key may
 * be rewritten. Undefined where one does not.
 */
const namesAlong = (
  from: SchemaAST.Objects,
  links: ReadonlyArray<SchemaAST.Link>,
): ReadonlyArray<Naming> | undefined => {
  if (!writesHeldKeys(from)) return undefined;
  let end = from;
  for (const link of links) {
    if (!renamesKeys(end, link)) return undefined;
    end = link.to as SchemaAST.Objects;
    if (!keepsOrder(end)) return undefined;
  }
  return from.propertySignatures.map(
    ({ name }, index) => [name, end.propertySignatures[index]!.name] as const,
  );
};

const namesFound = new WeakMap<Ast, ReadonlyArray<Naming> | null>();

/**
 * The name each field of one alternative is written under: its own, or the one a key rename such as
 * `Schema.encodeKeys` gives it on a struct or a class. Every field counts, renamed or not, because
 * any of them can put a value under its name, as a default or a transformation can where the value
 * holds nothing. Empty where the alternative writes no object, or writes only keys the value holds.
 * Undefined where another step could write any name: another transformation, middleware, a
 * declaration that is not a class, a rename whose fields need not keep their order, or a record
 * whose keys are encoded.
 */
const namesOf = (ast: Ast): ReadonlyArray<Naming> | undefined => {
  const known = namesFound.get(ast);
  if (known !== undefined) return known ?? undefined;
  let found: ReadonlyArray<Naming> | undefined;
  if (ast.encoding === undefined)
    found =
      ast._tag === "Declaration"
        ? undefined
        : ast._tag === "Objects"
          ? namesAlong(ast, [])
          : [];
  else if (takesNoObject(ast)) found = [];
  else if (ast._tag === "Objects") found = namesAlong(ast, ast.encoding);
  else {
    // A class writes the struct of its fields, and then what that struct is renamed to.
    const fields = classFields(ast);
    const [link, ...links] = ast.encoding;
    if (
      fields?._tag === "Objects" &&
      link.transformation._tag === "Transformation"
    )
      found =
        links.length === 0
          ? namesAlong(fields, fields.encoding ?? [])
          : fields.encoding === undefined
            ? namesAlong(fields, links)
            : undefined;
  }
  namesFound.set(ast, found ?? null);
  return found;
};

/**
 * The names every alternative here writes its fields under, or undefined where one could write any
 * name. Below a parent with a key rename, the parent's encoded side states each field's encoded form
 * beside the field's own schema, as `Schema.encodeKeys` builds it. That form has no encoding: it only
 * reads again what the schema wrote and adds no name of its own, so it is not counted.
 */
const namesAt = (
  types: ReadonlyArray<Ast>,
): ReadonlyArray<Naming> | undefined => {
  const names: Array<Naming> = [];
  const forms = new Set(
    types.flatMap((type) => {
      const form = SchemaAST.toEncoded(type);
      return form === type ? [] : [form];
    }),
  );
  const seen = new Set<Ast>();
  const visit = (ast: Ast): boolean => {
    if (seen.has(ast)) return true;
    seen.add(ast);
    if (ast.encoding === undefined && ast._tag === "Union")
      return ast.types.every(visit);
    if (ast.encoding === undefined && ast._tag === "Suspend")
      return visit(ast.thunk());
    const own = namesOf(ast);
    if (own === undefined) return false;
    names.push(...own);
    return true;
  };
  return types.every((type) => forms.has(type) || visit(type))
    ? names
    : undefined;
};

/**
 * The names a rename here writes each field under where nothing else here can write them: no other
 * field, renamed or not, in any alternative, is written under the name, and the value holds no key of
 * that name. A list's cells keep their places.
 */
const soleRenames = (
  types: ReadonlyArray<Ast>,
  given: object,
  keys: ReadonlyArray<PropertyKey>,
): ReadonlyMap<PropertyKey, ReadonlyArray<PropertyKey>> => {
  const sole = new Map<PropertyKey, Array<PropertyKey>>();
  const names = Array.isArray(given) ? undefined : namesAt(types);
  if (names === undefined) return sole;
  const held = new Set(keys);
  for (const [read, written] of names) {
    if (
      written === read ||
      held.has(written) ||
      names.some(([other, name]) => name === written && other !== read)
    )
      continue;
    const found = sole.get(read);
    if (found === undefined) sole.set(read, [written]);
    else if (!found.includes(written)) found.push(written);
  }
  return sole;
};

/**
 * Where `output`, written from `given` here, holds each of its fields: under the name it was given
 * by, or else under the name a key rename here writes it as, where nothing else here can write that
 * name. Undefined where neither holds it.
 */
const writtenNames = (
  types: ReadonlyArray<Ast>,
  given: object,
  keys: ReadonlyArray<PropertyKey>,
  output: unknown,
): ((key: PropertyKey) => PropertyKey | undefined) => {
  let renamed: ReturnType<typeof soleRenames> | undefined;
  return (key) => {
    if (has(output, key)) return key;
    renamed ??= soleRenames(types, given, keys);
    return renamed.get(key)?.find((name) => has(output, name));
  };
};

/** Whether a value keeps its names through a schema, as one with no encoding of its own does. */
const keepsNames = (ast: Ast): boolean =>
  ast.encoding === undefined
    ? ast._tag === "Union"
      ? ast.types.every(keepsNames)
      : ast._tag !== "Suspend" || keepsNames(ast.thunk())
    : takesNoObject(ast);

/** Whether a value's keys mean something here: it is plain, or a struct here reads it. */
const comparable = (sides: ReadonlyArray<Ast>, value: object): boolean =>
  isPlain(value) || sides.some(({ _tag }) => _tag === "Objects");

/** The closed structural sides used to establish that no member states a key. */
const closedSides = (ast: Ast): ReadonlyArray<Ast> | undefined => {
  if (takesNoObject(ast)) return [];
  if (ast._tag === "Union" && ast.encoding === undefined) {
    const members = ast.types.map(closedSides);
    return members.every((member) => member !== undefined)
      ? members.flat()
      : undefined;
  }
  return isStructural(ast) && !isSignaturelessObject(ast)
    ? objectSides(ast)
    : undefined;
};

/**
 * The schema of a native Some's payload where the source of its single encoding link exposes
 * that same payload directly. Effect's OptionFrom… codecs add nullish or optional cases around
 * the source and use its decoded projection as the Option declaration's only type parameter.
 * Keep the source itself for comparison, since it also states the payload's wire names.
 */
const optionSource = (ast: Ast): Ast | undefined => {
  if (
    ast._tag !== "Declaration" ||
    SchemaAST.resolveAt<{ readonly id: string }>("representation")(ast)?.id !==
      "effect/schema/Option" ||
    ast.typeParameters.length !== 1 ||
    ast.encoding?.length !== 1 ||
    ast.encoding[0].transformation._tag !== "Transformation"
  )
    return undefined;
  const payload = ast.typeParameters[0]!;
  const find = (source: Ast): Ast | undefined => {
    const decoded = SchemaAST.toType(source);
    // OptionFromOptionalKey also copies its source with an optional key context.
    const matches =
      decoded === payload ||
      (SchemaAST.isOptional(source) &&
        decoded.checks === payload.checks &&
        decoded.annotations === payload.annotations &&
        ((decoded._tag === "Objects" &&
          payload._tag === "Objects" &&
          decoded.propertySignatures === payload.propertySignatures &&
          decoded.indexSignatures === payload.indexSignatures) ||
          (decoded._tag === "Union" &&
            payload._tag === "Union" &&
            decoded.types === payload.types &&
            decoded.options === payload.options)));
    if (matches)
      return closedSides(source)?.some(({ _tag }) => _tag === "Objects")
        ? source
        : undefined;
    if (source._tag !== "Union" || source.encoding !== undefined)
      return undefined;
    const content = source.types.filter(
      (member) => member._tag !== "Null" && member._tag !== "Undefined",
    );
    return content.length === 1 ? find(content[0]!) : undefined;
  };
  return find(ast.encoding[0].to);
};

/** An own enumerable data property, without running a getter to find its value. */
const ownValue = (value: unknown, key: PropertyKey): unknown => {
  if (!isObject(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable === true && "value" in descriptor
    ? (descriptor.value as unknown)
    : undefined;
};

/**
 * Can the missing read field be left out of a visible Some payload? Inspect only losses the
 * ordinary comparison reported, after a strict schema write has succeeded. The proof follows
 * plain data apart from the native Some wrapper, and only through closed structural views.
 */
export const unstatedOptionField = (
  ast: Ast,
  given: unknown,
  read: unknown,
  output: unknown,
  path: Path,
): boolean => {
  if (path.length < 2) return false;
  let types: ReadonlyArray<Ast> = [ast];
  let inOption = false;
  for (const [index, key] of path.entries()) {
    const [type] = types;
    if (
      types.length === 1 &&
      type?._tag === "Declaration" &&
      key === "value" &&
      Option.isOption(given) &&
      Option.isSome(given) &&
      Option.isOption(read) &&
      Option.isSome(read)
    ) {
      const source = optionSource(type);
      if (source === undefined || !isObject(output)) return false;
      // The ordinary comparison indexes its output with the wrapper's own "value" key.
      // If that is also an object on the wire, it could have stood in for a different lost
      // field. Keep the original refusal where the two positions cannot be told apart.
      if (isObject(ownValue(output, key))) return false;
      inOption = true;
      types = [source];
    } else {
      if (!isObject(given) || !isPlainData(given)) return false;
      const sides = types.map(closedSides);
      if (sides.some((side) => side === undefined)) return false;
      const closed = sides.flatMap((side) => side ?? []);
      if (closed.some(statesPrototypeName)) return false;
      const children = typesAt(closed, key);
      if (children.length === 0)
        return (
          inOption &&
          index === path.length - 1 &&
          !Array.isArray(given) &&
          closed.some(({ _tag }) => _tag === "Objects") &&
          ownValue(given, key) !== undefined
        );
      types = [...new Set(children)];
      output = ownValue(output, key);
    }
    given = ownValue(given, key);
    read = ownValue(read, key);
  }
  return false;
};

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
  options: {
    /** Whether to report only places that are written under the names they are read by. */
    readonly sameNames?: boolean;
    /**
     * Whether a value kept as given has to be written too, as where a strict read kept it and a
     * loose write could still strip it. Each field is then followed into what was written under the
     * name it is written by, as {@link writtenNames} finds it.
     */
    readonly written?: boolean;
  } = {},
  path: Path = [],
  within?: View,
): ReadonlyArray<Path> => {
  if (!isObject(given)) return [];
  // A value kept as given holds every key in it; reading it again could only run its accessors.
  if (given === value)
    return options.written === true
      ? unwritten(types, given, output, path, within)
      : [];
  const view = viewAt(types, given, within);
  const { sides } = view;
  if (!comparable(sides, given)) return [];
  const decoded = new Set(
    types.flatMap((type) => decodedNames(type, given, view.known)),
  );
  const holdsAsWritten = (key: PropertyKey) =>
    has(output, key) &&
    (!isObject(value) ||
      !decoded.has(String(key)) ||
      Equal.equals(at(output, key), given[key]));
  const keys = keysOf(given, readAsArray(sides));
  const writtenAs =
    options.written === true
      ? writtenNames(types, given, keys, output)
      : undefined;
  return keys.flatMap((key) => {
    const here = [
      ...path,
      Array.isArray(given) ? (arrayIndex(key) ?? key) : key,
    ];
    if (given[key] === undefined || has(value, key) || holdsAsWritten(key))
      return missing(
        heldAt(view, key),
        given[key],
        at(value, key),
        at(output, writtenAs?.(key) ?? key),
        options,
        here,
        view,
      );
    return options.sameNames !== true || types.every(keepsNames) ? [here] : [];
  });
};

/**
 * What a write lost of a value a read kept as given: each key has to be in `output` under the name it
 * was given by, or under the name a key rename here writes it as, as {@link writtenNames} finds it.
 * Under a value that is not plain data, only a key a side states counts, unless its keys are open
 * there, because a key no member states is left out.
 */
const unwritten = (
  types: ReadonlyArray<Ast>,
  given: Record<PropertyKey, unknown>,
  output: unknown,
  path: Path,
  within: View | undefined,
): ReadonlyArray<Path> => {
  if (given === output) return [];
  const view = viewAt(types, given, within);
  const { sides } = view;
  if (!comparable(sides, given)) return [];
  const counts =
    isPlain(given) || leaveKeysOpen(view)
      ? () => true
      : (key: PropertyKey) => typesAt(sides, key).length > 0;
  const keys = keysOf(given, readAsArray(sides));
  const writtenAs = writtenNames(types, given, keys, output);
  return keys.flatMap((key) => {
    if (!counts(key)) return [];
    // Read each value once: a getter is the caller's code.
    const inner = given[key];
    if (inner === undefined) return [];
    const here = [
      ...path,
      Array.isArray(given) ? (arrayIndex(key) ?? key) : key,
    ];
    const name = writtenAs(key);
    if (name === undefined) return [here];
    return isObject(inner)
      ? unwritten(heldAt(view, key), inner, at(output, name), here, view)
      : [];
  });
};

/** Compares what went into a schema step at a position with what came out there. */
type RebuildCheck = (
  supplied: unknown,
  result: unknown,
  path: PropertyKey[],
  lost: Path[],
) => void;

/**
 * Record each defined, enumerable symbol field of `supplied` that `result` does not have, apart
 * from those the schema declares, which it writes under whatever name it chooses.
 */
function ownLostSymbols(
  supplied: object,
  result: object,
  path: ReadonlyArray<PropertyKey>,
  lost: Path[],
  declared?: ReadonlySet<PropertyKey>,
) {
  for (const key of Object.getOwnPropertySymbols(supplied))
    if (
      declared?.has(key) !== true &&
      !Object.hasOwn(result, key) &&
      Object.prototype.propertyIsEnumerable.call(supplied, key) &&
      Reflect.get(supplied, key) !== undefined
    )
      lost.push([...path, key]);
}

/** Whether an object was rebuilt from another's own fields and lost the content outside them. */
const lostHiddenContent = (supplied: object, result: object): boolean =>
  hasHiddenContent(supplied) &&
  isPlain(result) &&
  !Array.isArray(result) &&
  Reflect.ownKeys(result).every((key) => Object.hasOwn(supplied, key));

/** Descend one position, keeping the shared path stack balanced. */
const within = (
  check: RebuildCheck,
  supplied: unknown,
  result: unknown,
  path: PropertyKey[],
  key: PropertyKey,
  lost: Path[],
) => {
  path.push(key);
  check(supplied, result, path, lost);
  path.pop();
};

/** An object rebuilt from string keys: a record, or a struct with an index signature. */
const isIndexed = (ast: Ast): boolean =>
  ast._tag === "Objects" && ast.indexSignatures.length > 0;

/** A class: a declaration whose first encoding link leads to the struct of its fields. */
export const classFields = (ast: Ast): Ast | undefined =>
  ast._tag === "Declaration" && ast.encoding?.[0]?.to._tag === "Objects"
    ? ast.encoding[0].to
    : undefined;

/** The same path once, even when two members or two checks report it. */
export const uniquePaths = (paths: ReadonlyArray<Path>): ReadonlyArray<Path> =>
  paths.length < 2
    ? paths
    : paths.filter(
        (path, index) =>
          !paths
            .slice(0, index)
            .some(
              (earlier) =>
                earlier.length === path.length &&
                earlier.every((key, position) => key === path[position]),
            ),
      );

type Comparison = (supplied: unknown, result: unknown) => ReadonlyArray<Path>;

const rebuildChecks = {
  schema: new WeakMap<Ast, Comparison | null>(),
  json: new WeakMap<Ast, Comparison | null>(),
};

/**
 * Where Effect itself rebuilds an object from its string fields and drops what they do not hold,
 * before any writer can see it: a symbol field, and the content of a built-in such as a `Map`.
 *
 * @remarks
 * The comparison runs twice, at the same positions: from the caller's value to the decoded value,
 * and from the decoded value to what the schema writes. An index signature rebuilds its object
 * from string keys, so a record drops a symbol field on either step, and so does a link whose
 * encoded end is a record, such as a record decoded to a struct. A symbol key the node's own
 * fields declare is the schema's to write, under whatever name it chooses. A class is read through
 * its fields; a symbol at its root is a key no field states, which a class strips as a struct
 * does. For JSON, the canonical codec of `Schema.ObjectKeyword` also copies only the top-level
 * string fields of an object and the positions of an array. Everywhere else a symbol field or a
 * built-in reaches the writer, which refuses it there. This check does not visit a declaration's
 * type parameters. The missing-field comparison separately uses the visible source of an
 * Option codec to recognize unstated keys in a `Some` payload.
 *
 * The comparison is compiled once per schema and visits only the positions where such a node can
 * be, with one shared path that is copied only for a loss, so an array of rows checks each row
 * without rediscovering its schema or allocating a path. A suspended schema is read on first use.
 */
export function rebuildLoss(ast: Ast, json: boolean): Comparison | undefined {
  const memo = rebuildChecks[json ? "json" : "schema"];
  const known = memo.get(ast);
  if (known !== undefined) return known ?? undefined;
  const cache = new Map<Ast, RebuildCheck | undefined>();
  const build = (node: Ast): RebuildCheck | undefined => {
    if (cache.has(node)) return cache.get(node);
    const check = make(node);
    cache.set(node, check);
    return check;
  };
  /** Symbols compared at this very position, where the node rebuilds the object. */
  const here = (node: Ast): RebuildCheck | undefined => {
    const end = encodedEnd(node);
    if (isIndexed(node) || (end !== node && isIndexed(end))) {
      const declared = new Set(
        fieldsOf(node)
          .map(({ name }) => name)
          .filter((name) => typeof name === "symbol"),
      );
      return (supplied, result, path, lost) => {
        if (
          supplied !== result &&
          isObject(supplied) &&
          isObject(result) &&
          !Array.isArray(supplied)
        ) {
          if (lostHiddenContent(supplied, result)) lost.push([...path]);
          else ownLostSymbols(supplied, result, path, lost, declared);
        }
      };
    }
    if (!json || node._tag !== "ObjectKeyword" || node.encoding !== undefined)
      return undefined;
    return (supplied, result, path, lost) => {
      if (supplied === result || !isObject(supplied) || !isObject(result))
        return;
      if (!Array.isArray(supplied)) {
        if (lostHiddenContent(supplied, result)) lost.push([...path]);
        else ownLostSymbols(supplied, result, path, lost);
        return;
      }
      const extra = extraArrayField(supplied, supplied.length);
      if (extra !== undefined && !Object.hasOwn(result, extra))
        lost.push([...path, extra]);
    };
  };
  const inner = (node: Ast): RebuildCheck | undefined => {
    switch (node._tag) {
      case "Declaration": {
        const fields = classFields(node);
        return fields === undefined ? undefined : build(fields);
      }
      case "Objects": {
        const properties = node.propertySignatures.flatMap(({ name, type }) => {
          const check = build(type);
          return check === undefined ? [] : [[name, check] as const];
        });
        const indexes = node.indexSignatures.flatMap(({ type }) => {
          const check = build(type);
          return check === undefined ? [] : [check];
        });
        if (properties.length === 0 && indexes.length === 0) return undefined;
        return (supplied, result, path, lost) => {
          if (supplied === result || !isObject(supplied) || !isObject(result))
            return;
          for (const [name, check] of properties)
            within(check, supplied[name], result[name], path, name, lost);
          if (indexes.length > 0)
            for (const name of Object.keys(supplied))
              for (const check of indexes)
                within(check, supplied[name], result[name], path, name, lost);
        };
      }
      case "Arrays": {
        const fixed = node.elements.map(build);
        const rest = node.rest.map(build);
        if (!fixed.some(Boolean) && !rest.some(Boolean)) return undefined;
        return (supplied, result, path, lost) => {
          if (
            supplied === result ||
            !Array.isArray(supplied) ||
            !Array.isArray(result)
          )
            return;
          const length = Math.min(supplied.length, result.length);
          const head = Math.min(fixed.length, length);
          for (let index = 0; index < head; index++) {
            const check = fixed[index];
            if (check)
              within(check, supplied[index], result[index], path, index, lost);
          }
          if (rest.length === 0) return;
          const end = Math.max(fixed.length, length - rest.length + 1);
          const spread = rest[0];
          if (spread)
            for (let index = fixed.length; index < end; index++)
              within(spread, supplied[index], result[index], path, index, lost);
          for (let index = end; index < length; index++) {
            const check = rest[index - end + 1];
            if (check)
              within(check, supplied[index], result[index], path, index, lost);
          }
        };
      }
      case "Union": {
        const members = node.types.flatMap((member) => {
          const check = build(member);
          return check === undefined ? [] : [[member, check] as const];
        });
        if (members.length === 0) return undefined;
        return (supplied, result, path, lost) => {
          for (const [member, check] of members)
            if (!ruledOut(member, supplied))
              check(supplied, result, path, lost);
        };
      }
      case "Suspend": {
        // Building a request must not force the thunk, whose target may be assigned later.
        let target: RebuildCheck | undefined | null = null;
        return (supplied, result, path, lost) => {
          if (target === null) target = build(node.thunk());
          target?.(supplied, result, path, lost);
        };
      }
      default:
        return undefined;
    }
  };
  const make = (node: Ast): RebuildCheck | undefined => {
    const first = here(node);
    const second = inner(node);
    if (first === undefined || second === undefined) return first ?? second;
    return (supplied, result, path, lost) => {
      first(supplied, result, path, lost);
      second(supplied, result, path, lost);
    };
  };
  const check = build(ast);
  const compare =
    check &&
    ((supplied: unknown, result: unknown): ReadonlyArray<Path> => {
      const lost: Path[] = [];
      check(supplied, result, [], lost);
      return uniquePaths(lost);
    });
  memo.set(ast, compare ?? null);
  return compare;
}

const notHeld = new SchemaIssue.InvalidValue({
  message: "The schema cannot keep this field with the rest of the value",
});

const valueNotHeld = new SchemaIssue.InvalidValue({
  message: "The schema cannot keep the content of this value",
});

const notHeldAt = (path: Path) =>
  path.length === 0 ? valueNotHeld : new SchemaIssue.Pointer(path, notHeld);

/** A refusal that names the fields and, like any other schema failure here, leaves out values. */
export const refusal = (
  ast: Ast,
  [first, ...others]: readonly [Path, ...ReadonlyArray<Path>],
): Schema.SchemaError =>
  new Schema.SchemaError(
    new SchemaIssue.Composite(ast, [
      notHeldAt(first),
      ...others.map(notHeldAt),
    ]),
  );

/** Whether a schema holds a choice of member, which only a stacked schema can settle for it. */
export const choosesMember = holding(isMemberChoice);

const resolvedChoices = new WeakMap<Ast, boolean>();

/** {@link choosesMember} once a value is at hand, when what a suspension stands for can be read. */
export const choosesMemberResolved = (root: Ast): boolean => {
  let chooses = resolvedChoices.get(root);
  if (chooses === undefined) {
    const seen = new Set<Ast>();
    const visit = (ast: Ast): boolean => {
      if (seen.has(ast)) return false;
      seen.add(ast);
      return (
        isObjectUnion(ast) ||
        (ast._tag === "Suspend" && visit(ast.thunk())) ||
        partsOf(ast).some(visit) ||
        (ast.encoding ?? []).some(({ to }) => visit(to))
      );
    };
    resolvedChoices.set(root, (chooses = visit(root)));
  }
  return chooses;
};

/**
 * Whether a schema holds a choice that can cost a field, of member or of side, anywhere it can be
 * seen, apart from the separate Void rule. `Schema.NullOr` around a struct has no such choice.
 */
export const choosing = holding(
  (ast) => isMemberChoice(ast) || isSideChoice(ast),
);

/** Whether a read could report a visible oneOf, including one in an unresolved suspension. */
const couldReportOneOf = holding(
  (ast) =>
    ast._tag === "Suspend" ||
    (ast._tag === "Union" && ast.options?.mode === "oneOf"),
);

const possibleOneOfs = new WeakMap<Ast, boolean>();

export const mayHaveOneOf = (ast: Ast): boolean => {
  let possible = possibleOneOfs.get(ast);
  if (possible === undefined)
    possibleOneOfs.set(ast, (possible = couldReportOneOf(ast)));
  return possible;
};
