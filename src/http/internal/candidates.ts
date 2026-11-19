import { identity, Predicate, Schema, SchemaAST } from "effect";

/** The kinds of value Effect tells union members apart by. */
type Kind =
  | "null"
  | "undefined"
  | "string"
  | "number"
  | "boolean"
  | "symbol"
  | "bigint"
  | "object"
  | "array"
  | "function";

const everyKind: ReadonlyArray<Kind> = [
  "null",
  "undefined",
  "string",
  "number",
  "boolean",
  "symbol",
  "bigint",
  "object",
  "array",
  "function",
];

/** What a struct that states no field is offered: any value but `null` and `undefined`. */
const anyValue: ReadonlyArray<Kind> = everyKind.filter(
  (kind) => kind !== "null" && kind !== "undefined",
);

const kindOf = (input: unknown): Kind =>
  input === null
    ? "null"
    : Array.isArray(input)
      ? "array"
      : (typeof input as Kind);

const unknown = Schema.Unknown.ast;

/** The shape a member is selected by: the end of its encoding, or anything past a suspension. */
const candidateOf = (ast: SchemaAST.AST): SchemaAST.AST => {
  for (;;) {
    if (ast._tag === "Suspend") return unknown;
    const encoding = ast.encoding;
    if (encoding === undefined) return ast;
    if (
      encoding.some(
        ({ transformation }) =>
          transformation._tag === "Middleware" &&
          transformation.decode !== identity,
      )
    )
      return unknown;
    ast = encoding[encoding.length - 1]!.to;
  }
};

const kindsOf = (ast: SchemaAST.AST): ReadonlyArray<Kind> => {
  switch (ast._tag) {
    case "Null":
      return ["null"];
    case "Undefined":
      return ["undefined"];
    case "String":
    case "TemplateLiteral":
      return ["string"];
    case "Number":
      return ["number"];
    case "Boolean":
      return ["boolean"];
    case "Symbol":
    case "UniqueSymbol":
      return ["symbol"];
    case "BigInt":
      return ["bigint"];
    case "Arrays":
      return ["array"];
    case "ObjectKeyword":
      return ["object", "array", "function"];
    case "Objects":
      return ast.propertySignatures.length > 0 || ast.indexSignatures.length > 0
        ? ["object"]
        : anyValue;
    case "Enum":
      return [...new Set(ast.enums.map(([, value]) => typeof value as Kind))];
    case "Literal":
      return [typeof ast.literal as Kind];
    case "Union":
      return [
        ...new Set(ast.types.flatMap((type) => kindsOf(candidateOf(type)))),
      ];
    default:
      return everyKind;
  }
};

interface Sentinel {
  readonly key: PropertyKey;
  readonly literal: unknown;
}

const literalOf = (
  ast: SchemaAST.AST,
): { readonly value: unknown } | undefined =>
  ast._tag === "Literal"
    ? { value: ast.literal }
    : ast._tag === "UniqueSymbol"
      ? { value: ast.symbol }
      : undefined;

/**
 * Required literal fields, which pre-select members as tags. A class keeps its own in an annotation.
 * A field is followed to the end of its encoding before Effect asks whether it is optional, so a tag
 * that is optional on one side only counts by the side the union parses.
 */
const sentinelsOf = (ast: SchemaAST.AST): ReadonlyArray<Sentinel> => {
  switch (ast._tag) {
    case "Declaration": {
      const sentinels: unknown = ast.annotations?.["~sentinels"];
      return Array.isArray(sentinels) ? (sentinels as Array<Sentinel>) : [];
    }
    case "Objects":
      return ast.propertySignatures.flatMap(({ name, type }) => {
        const candidate = candidateOf(type);
        const literal = SchemaAST.isOptional(candidate)
          ? undefined
          : literalOf(candidate);
        return literal === undefined
          ? []
          : [{ key: name, literal: literal.value }];
      });
    case "Arrays":
      return ast.elements.flatMap((element, index) => {
        const candidate = candidateOf(element);
        const literal = SchemaAST.isOptional(candidate)
          ? undefined
          : literalOf(candidate);
        return literal === undefined
          ? []
          : [{ key: index, literal: literal.value }];
      });
    case "Union": {
      if (ast.types.length === 0) return [];
      const members = ast.types.map((type) => sentinelsOf(candidateOf(type)));
      return members[0]!.filter((sentinel) =>
        members.every((others) =>
          others.some(
            (other) =>
              other.key === sentinel.key && other.literal === sentinel.literal,
          ),
        ),
      );
    }
    case "Suspend":
      return sentinelsOf(ast.thunk());
    default:
      return [];
  }
};

const prototypeKeys = new Set<PropertyKey>(
  Reflect.ownKeys(Object.prototype),
).add("__proto__");

/**
 * Whether a value holds a field: an own property, or one it inherits from somewhere other than
 * `Object.prototype`, as an accessor on a class is. A name every object inherits, such as
 * `toString`, is no field of the value. This is also how Effect 4.1.4 looks for a tag.
 */
export const hasField = (input: object, key: PropertyKey): boolean =>
  Object.hasOwn(input, key) ||
  (key in input &&
    !prototypeKeys.has(typeof key === "number" ? String(key) : key));

/** Effect 4.0.7's rule: any name the value has through `in`, but `__proto__` only as its own. */
const hasName = (input: object, key: PropertyKey): boolean =>
  key === "__proto__" ? Object.hasOwn(input, key) : key in input;

let installedRule: typeof hasField | undefined;

/**
 * How the installed Effect looks for a tag, found once by encoding through a union whose two
 * readings differ. Under {@link hasField} the first member's tag named `constructor` is missing, so
 * that member is tried and its first field's middleware runs; under {@link hasName} every object
 * has a `constructor`, which does not match, so that member is never tried.
 */
const tagRule = (): typeof hasField => {
  if (installedRule !== undefined) return installedRule;
  let tried = false;
  const Tagged = Schema.Struct({
    seen: Schema.String.pipe(
      Schema.middlewareEncoding((effect) => {
        tried = true;
        return effect;
      }),
    ),
    kind: Schema.Literal("a"),
    constructor: Schema.Literal("b"),
  });
  Schema.encodeUnknownExit(
    Schema.Union([Tagged, Schema.Struct({ kind: Schema.Literal("a") })]),
  )({ seen: "", kind: "a" });
  return (installedRule = tried ? hasField : hasName);
};

const none: ReadonlyArray<number> = [];

/**
 * The members Effect tries for an input when it encodes through a union, in order.
 *
 * @remarks
 * Effect pre-selects a union's members by kind of value and by literal tags before it runs any
 * member, so a member whose tag does not match never runs its encoder, middleware or checks. The
 * index Effect builds for that is internal, so this reads the same facts from the members' ASTs, as
 * Effect follows each one to the end of its encoding, and applies the same rules. Effect 4.0.7 and
 * 4.1.4 differ only in how they look for a tag named after an `Object.prototype` member, and the
 * installed version's way is used. `members` are the union's members as encoding parses them. The
 * parity tests compare this with Effect's own writes; revisit it when a supported Effect changes how
 * it selects union members.
 */
export const candidates = (
  members: ReadonlyArray<SchemaAST.AST>,
): ((input: unknown) => ReadonlyArray<number>) => {
  type Index = [Map<unknown, Set<number>>, Set<number>];
  const has = tagRule();
  const fieldOf = (input: object, key: PropertyKey): unknown =>
    has(input, key) ? (input as Record<PropertyKey, unknown>)[key] : undefined;
  let bySentinel: Map<PropertyKey, Index> | undefined;
  let sentinelCount = 0;
  let otherwise: Partial<Record<Kind, Array<number>>> | undefined;
  let literals: Map<unknown, Array<number>> | undefined;
  let onlyLiterals = true;
  const literalAt: Array<{ readonly value: unknown } | undefined> = [];
  members.forEach((member, index) => {
    const encoded = candidateOf(member);
    if (encoded._tag === "Never") return;
    const literal = literalOf(encoded);
    if (literal !== undefined) {
      literals ??= new Map();
      literalAt[index] = literal;
      const at = literals.get(literal.value);
      if (at === undefined) literals.set(literal.value, [index]);
      else at.push(index);
    } else onlyLiterals = false;
    const sentinels = sentinelsOf(encoded);
    if (sentinels.length > 0) {
      bySentinel ??= new Map();
      sentinelCount++;
      for (const { key, literal: value } of sentinels) {
        let entry = bySentinel.get(key);
        if (entry === undefined)
          bySentinel.set(key, (entry = [new Map(), new Set()]));
        entry[1].add(index);
        let indexes = entry[0].get(value);
        if (indexes === undefined) entry[0].set(value, (indexes = new Set()));
        indexes.add(index);
      }
    } else {
      otherwise ??= {};
      for (const kind of kindsOf(encoded)) (otherwise[kind] ??= []).push(index);
    }
  });
  const fallback = (kind: Kind): ReadonlyArray<number> =>
    otherwise?.[kind] ?? none;
  if (onlyLiterals && literals !== undefined) {
    const known = literals;
    return (input) => known.get(input) ?? none;
  }
  if (bySentinel?.size === 1 && otherwise === undefined) {
    const [key, [byValue]] = bySentinel.entries().next().value!;
    // Members were indexed in order, so each value's members already are.
    const ordered = new Map(
      Array.from(byValue, ([value, indexes]) => [value, [...indexes]]),
    );
    return (input) => {
      if (!Predicate.isObjectKeyword(input)) return none;
      const value = fieldOf(input, key);
      return value === undefined ? none : (ordered.get(value) ?? none);
    };
  }
  if (bySentinel !== undefined) {
    const sentinels = bySentinel;
    // A key every tagged member owns can seed the selection; prefer the one with the most values.
    let common: [PropertyKey, Index] | undefined;
    for (const entry of sentinels)
      if (
        (common === undefined || entry[1][0].size > common[1][0].size) &&
        entry[1][1].size === sentinelCount
      )
        common = entry;
    return (input) => {
      const kind = kindOf(input);
      if (!Predicate.isObjectKeyword(input)) return fallback(kind);
      const selected = new Set(otherwise?.[kind]);
      let direct: PropertyKey | undefined;
      if (common !== undefined) {
        const [key, [byValue]] = common;
        if (has(input, key)) {
          const match = byValue.get(fieldOf(input, key));
          if (match === undefined) return fallback(kind);
          for (const index of match) selected.add(index);
          direct = key;
        }
      }
      if (direct === undefined)
        for (const [key, [byValue]] of sentinels)
          if (has(input, key))
            for (const index of byValue.get(fieldOf(input, key)) ?? [])
              selected.add(index);
      // A missing key is neutral; an observed one rules out the members that own it and differ.
      for (const [key, [byValue, owners]] of sentinels) {
        if (key === direct || !has(input, key)) continue;
        const match = byValue.get(fieldOf(input, key));
        for (const index of selected)
          if (owners.has(index) && match?.has(index) !== true)
            selected.delete(index);
      }
      return [...selected].toSorted((left, right) => left - right);
    };
  }
  return (input) => {
    const found = fallback(kindOf(input));
    return literals === undefined
      ? found
      : found.filter(
          (index) =>
            literalAt[index] === undefined || literalAt[index].value === input,
        );
  };
};
