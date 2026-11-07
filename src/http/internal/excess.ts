import { Schema, SchemaAST, SchemaIssue } from "effect";

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

/** A choice of member: a union between objects, or a suspended schema, which may not exist yet. */
const isMemberChoice = (ast: Ast): boolean =>
  ast._tag === "Suspend" ||
  (ast._tag === "Union" && ast.types.filter(readsKeys).length > 1);

/**
 * A choice of side: two ends that do not state the same names, as a renamed field's do. A value on
 * the encoded side can then fit the decoded side by losing the names it holds. An encoded side with
 * no keys, such as text, has none to lose.
 */
const isSideChoice = (ast: Ast): boolean => {
  const end = encodedEnd(ast);
  if (end === ast || !readsKeys(end)) return false;
  const decoded = fieldsOf(ast).map(({ name }) => name);
  const encoded = fieldsOf(end).map(({ name }) => name);
  return (
    end._tag !== "Objects" ||
    end.indexSignatures.length > 0 ||
    decoded.length !== encoded.length ||
    decoded.some((name) => !encoded.includes(name))
  );
};

const holding = (isChoice: (ast: Ast) => boolean) => {
  const holds = (ast: Ast): boolean =>
    isChoice(ast) ||
    partsOf(ast).some(holds) ||
    (ast.encoding ?? []).some(({ to }) => holds(to));
  return holds;
};

const holdsMemberChoice = holding(isMemberChoice);

/**
 * Whether a schema holds a choice that can cost a field, of member or of side, anywhere in it. Any
 * other schema skips the strict pass. `Schema.NullOr` around a struct has no such choice.
 */
const holdsChoice = holding((ast) => isMemberChoice(ast) || isSideChoice(ast));

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
  const open = leaveKeysOpen(sides);
  return [...keysOf(value), ...unlisted(sides, value)].filter(
    (key) =>
      value[key] !== undefined && (open || typesAt(sides, key).length > 0),
  );
};

const has = (value: unknown, key: PropertyKey): boolean =>
  isObject(value) && key in value && value[key] !== undefined;

const at = (value: unknown, key: PropertyKey): unknown =>
  isObject(value) ? value[key] : undefined;

/**
 * Whether a name is only a wire name, for a field that holds a choice of member the types under that
 * name do not show. A renamed field's encoded type is flattened, so text that holds JSON reads as
 * text there, and nothing says which field it belongs to. Its strict read failed with the whole
 * value's, so it cannot be shown to have kept everything.
 */
const hidesChoice = (sides: ReadonlyArray<Ast>, key: PropertyKey): boolean =>
  !typesAt(sides, key).some(holdsMemberChoice) &&
  sides.some((side) => {
    const decoded = fieldsOf(side);
    const encoded = fieldsOf(encodedEnd(side)).map(({ name }) => name);
    return (
      encoded.includes(key) &&
      decoded.every(({ name }) => name !== key) &&
      decoded.some(
        ({ name, type }) => !encoded.includes(name) && holdsMemberChoice(type),
      )
    );
  });

/** A field that may be gone. With `types`, it is only gone if they cannot read `value` strictly. */
export interface Missing {
  readonly path: Path;
  readonly types?: ReadonlyArray<Ast>;
  readonly value?: unknown;
}

/** Whether a value's keys mean something here: it is plain, or a struct here reads it. */
const comparable = (sides: ReadonlyArray<Ast>, value: object): boolean =>
  isPlain(value) || sides.some(({ _tag }) => _tag === "Objects");

/**
 * What a read lost from `given`, a {@link normalised} value, by comparing it with what came out. A
 * field has to be in the decoded value or in what was written. Under a name a member decodes, what
 * was written has to be what was given too, because that name can be another field's on the wire.
 *
 * A value that cannot be compared, such as text that holds JSON or a `Map`, may hide a choice. It
 * comes back with its `types`, so that a strict read can settle it. Text is on the encoded side
 * already, so only a choice of member can hide in it.
 */
export const missing = (
  types: ReadonlyArray<Ast>,
  given: unknown,
  value: unknown,
  output: unknown,
  path: Path = [],
): ReadonlyArray<Missing> => {
  if (given === undefined) return [];
  const sides = types.flatMap((type) => sidesOf(type, given));
  if (!isObject(given) || !comparable(sides, given)) {
    const choosing = types.filter(
      isObject(given) ? holdsChoice : holdsMemberChoice,
    );
    return choosing.length > 0 ? [{ path, types: choosing, value: given }] : [];
  }
  const decoded = new Set(types.flatMap((type) => decodedNames(type, given)));
  const holdsAsWritten = (key: PropertyKey) =>
    has(output, key) &&
    !hidesChoice(sides, key) &&
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
  const renamed = narrow.pipe(Schema.encodeKeys({ a: "A" }));
  assume({
    "a union of structs holds a choice": holdsChoice(Probe.ast),
    "a struct or null holds no choice": !holdsChoice(Schema.NullOr(narrow).ast),
    "a renamed field holds a choice": holdsChoice(renamed.ast),
    "a renamed field holds no choice of member": !holdsMemberChoice(
      renamed.ast,
    ),
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

/** Whether a schema has a choice of member, which only a stacked schema can settle for it. */
export const choosesMember = (ast: Ast): boolean => {
  checkReadable();
  return holdsMemberChoice(ast);
};
