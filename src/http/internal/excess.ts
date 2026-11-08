import { Equal, Schema, SchemaAST, SchemaIssue } from "effect";

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

const keysOf = (value: object): ReadonlyArray<PropertyKey> =>
  Reflect.ownKeys(value).filter((key) =>
    Object.prototype.propertyIsEnumerable.call(value, key),
  );

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

/** The schemas a value can be read against here: each member its tag leaves, on each side. */
const sidesOf = (ast: Ast, value: unknown): ReadonlyArray<Ast> => [
  ...(ast._tag === "Union"
    ? ast.types
        .filter((member) => !ruledOut(member, value))
        .flatMap((member) => sidesOf(member, value))
    : ast._tag === "Suspend"
      ? sidesOf(ast.thunk(), value)
      : [ast]),
  ...(ast.encoding ?? []).flatMap(({ to }) => sidesOf(to, value)),
];

/** The schemas of what these sides hold under one key. */
const typesAt = (
  sides: ReadonlyArray<Ast>,
  key: PropertyKey,
): ReadonlyArray<Ast> =>
  sides.flatMap((side) => {
    if (side._tag === "Arrays") {
      const element = side.elements[Number(key)];
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
      : fieldsOf(ast).map(({ name }) => String(name));

/** Whether these sides leave a value's keys open, so none can be called unstated. */
const leaveKeysOpen = (sides: ReadonlyArray<Ast>): boolean =>
  sides.some(
    ({ _tag }) =>
      _tag === "Any" || _tag === "Unknown" || _tag === "ObjectKeyword",
  ) || !sides.some(({ _tag }) => _tag === "Objects" || _tag === "Arrays");

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
          value[name] !== undefined &&
          !Object.prototype.propertyIsEnumerable.call(value, name),
      );

/**
 * Whether only a struct can read a value here. A struct builds a plain object from any object, so a
 * class instance loses nothing by becoming one. A declaration may need the instance itself, so
 * there it keeps its keys, and stays an instance unless something in it has to change.
 */
const readAsStruct = (sides: ReadonlyArray<Ast>, open: boolean): boolean =>
  !open && !sides.some(({ _tag }) => _tag === "Declaration");

/** Bring a value's {@link unlisted} fields out as keys, at any depth, and take out what `drops` says. */
const rewriting = (drops: (item: unknown, stated: boolean) => boolean) => {
  const rewrite = (types: ReadonlyArray<Ast>, value: unknown): unknown => {
    if (types.length === 0 || !isObject(value)) return value;
    const sides = types.flatMap((type) => sidesOf(type, value));
    const hidden = unlisted(sides, value);
    const open = leaveKeysOpen(sides);
    const plain = isPlain(value);
    const asStruct = !plain && readAsStruct(sides, open);
    const isList = Array.isArray(value);
    const keys = [...keysOf(value), ...hidden];
    const entries = keys.flatMap((key) => {
      const item = value[key];
      const inner = typesAt(sides, key);
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
      entries.every(([key, item]) => item === value[key]);
    return same
      ? value
      : isList
        ? entries.map(([, item]) => item)
        : Object.fromEntries(entries);
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
): ReadonlyArray<Path> => {
  if (!isObject(given)) return [];
  const sides = types.flatMap((type) => sidesOf(type, given));
  if (!comparable(sides, given)) return [];
  const decoded = new Set(types.flatMap((type) => decodedNames(type, given)));
  const holdsAsWritten = (key: PropertyKey) =>
    has(output, key) &&
    (!isObject(value) ||
      !decoded.has(String(key)) ||
      Equal.equals(at(output, key), given[key]));
  return keysOf(given).flatMap((key) => {
    const here = [...path, Array.isArray(given) ? Number(key) : key];
    return given[key] === undefined || has(value, key) || holdsAsWritten(key)
      ? missing(
          typesAt(sides, key),
          given[key],
          at(value, key),
          at(output, key),
          here,
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
 * seen. Any other schema skips the strict pass. `Schema.NullOr` around a struct has no such choice.
 */
export const choosing = holding(
  (ast) => isMemberChoice(ast) || isSideChoice(ast),
);
