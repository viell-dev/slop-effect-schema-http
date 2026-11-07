import { Schema, SchemaAST, SchemaIssue } from "effect";

/** Where a key sits in a value, one step for each level. */
export type Path = ReadonlyArray<PropertyKey>;

type Ast = SchemaAST.AST;

/** Parse options that make a schema refuse what it would strip. */
export const strict: SchemaAST.ParseOptions = { onExcessProperty: "error" };

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
    case "Declaration":
      return ast.typeParameters;
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

/**
 * Whether a schema holds a union with a choice between objects, anywhere in it. Only such a choice
 * can cost a field, so any other schema skips the strict pass. `Schema.NullOr` around a struct has
 * no such choice. A suspended schema may not exist yet, so it counts as one.
 */
const holdsChoice = (ast: Ast): boolean =>
  ast._tag === "Suspend" ||
  (ast._tag === "Union" && ast.types.filter(readsKeys).length > 1) ||
  partsOf(ast).some(holdsChoice) ||
  (ast.encoding ?? []).some(({ to }) => holdsChoice(to));

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

/** A plain object or a list, which can be taken apart. A class instance has to stay one. */
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

/** Whether a literal field holds another literal on every side, which a tag can rule out by. */
const refusesLiteral = (type: Ast, value: unknown): boolean =>
  [type, ...(type.encoding ?? []).map(({ to }) => to)].every(
    (side) => side._tag === "Literal" && side.literal !== value,
  );

/** Whether a member's tag rules it out for a value, as Effect's union does before it reads one. */
const ruledOut = (member: Ast, value: unknown): boolean =>
  isObject(value) &&
  fieldsOf(member).some(
    ({ name, type }) =>
      !SchemaAST.isOptional(type) &&
      value[name] !== undefined &&
      refusesLiteral(type, value[name]),
  );

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
export const decodedNames = (
  ast: Ast,
  value?: unknown,
): ReadonlyArray<string> =>
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
 * What a caller means by a value, at any depth of plain objects and lists: no key set to `undefined`,
 * which holds nothing, and no key the schema does not state, which a struct would strip anyway. A
 * member a tag has ruled out states nothing. Returns `value` itself if there is nothing to take out.
 */
export const normalised = (
  types: ReadonlyArray<Ast>,
  value: unknown,
): unknown => {
  if (types.length === 0 || !isPlain(value)) return value;
  const sides = types.flatMap((type) => sidesOf(type, value));
  const open = leaveKeysOpen(sides);
  const isList = Array.isArray(value);
  const keys = keysOf(value);
  const entries = keys.flatMap((key) => {
    const item = value[key];
    const inner = typesAt(sides, key);
    return !isList && (item === undefined || (inner.length === 0 && !open))
      ? []
      : [[key, normalised(inner, item)] as const];
  });
  const same =
    entries.length === keys.length &&
    entries.every(([key, item]) => item === value[key]);
  return same
    ? value
    : isList
      ? entries.map(([, item]) => item)
      : Object.fromEntries(entries);
};

const has = (value: unknown, key: PropertyKey): boolean =>
  isObject(value) && key in value && value[key] !== undefined;

const at = (value: unknown, key: PropertyKey): unknown =>
  isObject(value) ? value[key] : undefined;

/** A field that may be gone. With `types`, it is only gone if they cannot read `value` strictly. */
export interface Missing {
  readonly path: Path;
  readonly types?: ReadonlyArray<Ast>;
  readonly value?: unknown;
}

/**
 * What a read lost from `given`, a {@link normalised} value, by comparing it with what came out. A
 * field has to be in the decoded value or in what was written. Under a name a member decodes, what
 * was written has to be what was given too, because that name can be another field's on the wire.
 *
 * A value that cannot be compared, such as text that holds JSON or a `Map`, may hide a choice of
 * member. It comes back with its `types`, so that a strict read can settle it.
 */
export const missing = (
  types: ReadonlyArray<Ast>,
  given: unknown,
  value: unknown,
  output: unknown,
  path: Path = [],
): ReadonlyArray<Missing> => {
  if (given === undefined) return [];
  if (!isPlain(given)) {
    const choosing = types.filter(holdsChoice);
    return choosing.length > 0 ? [{ path, types: choosing, value: given }] : [];
  }
  const sides = types.flatMap((type) => sidesOf(type, given));
  const decoded = new Set(types.flatMap((type) => decodedNames(type, given)));
  const holdsAsWritten = (key: PropertyKey) =>
    has(output, key) &&
    (!isObject(value) ||
      !decoded.has(String(key)) ||
      isObject(given[key]) ||
      at(output, key) === given[key]);
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
      : [{ path: here }];
  });
};

const notHeld = new SchemaIssue.InvalidValue({
  message: "No union member holds this field with the rest of the value",
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

/**
 * Stop at a reading of Effect that does not hold. These read its schema structure, which a newer
 * Effect could change, and a reading that quietly came back empty would bring silent losses back.
 */
export const assume = (readings: Readonly<Record<string, boolean>>): void => {
  const wrong = Object.keys(readings).filter((name) => !readings[name]);
  if (wrong.length > 0)
    throw new Error(
      `viell-effect-schema-http cannot read this version of Effect, so it cannot keep its promise about lost fields. Use a version it was tested with, and report this: ${wrong.join("; ")}.`,
    );
};

let readable = false;

/** Read a small union once, so a change in Effect fails loudly here and not silently in a call. */
const checkReadable = (): void => {
  if (readable) return;
  readable = true;
  const text = Schema.String;
  const narrow = Schema.Struct({ a: text });
  const Probe = Schema.Union([narrow, Schema.Struct({ a: text, b: text })]);
  assume({
    "a union of structs holds a choice": holdsChoice(Probe.ast),
    "a struct or null holds no choice": !holdsChoice(Schema.NullOr(narrow).ast),
    "a strict read keeps a later member's field":
      "b" in Schema.decodeUnknownSync(Probe)({ a: "", b: "" }, strict),
    "a key no member states can be found": !(
      "z" in (normalised([Probe.ast], { a: "", z: "" }) as object)
    ),
    "a member's field can be found":
      "b" in (normalised([Probe.ast], { a: "", b: "" }) as object),
    "a lost field can be found":
      missing([Probe.ast], { a: "", b: "" }, { a: "" }, { a: "" }).length === 1,
  });
};

/**
 * Whether a schema has a choice that can cost a field. This is the way in for everything that acts
 * on the answer, so nothing can ask before the reading has been checked: a change in Effect would
 * otherwise answer "no", and every schema would skip the strict read with no error.
 */
export const choosing = (ast: Ast): boolean => {
  checkReadable();
  return holdsChoice(ast);
};
