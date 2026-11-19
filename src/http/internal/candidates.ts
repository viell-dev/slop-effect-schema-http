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
        : everyKind;
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

/** Required literal fields, which pre-select members as tags. A class keeps its own in an annotation. */
const sentinelsOf = (ast: SchemaAST.AST): ReadonlyArray<Sentinel> => {
  switch (ast._tag) {
    case "Declaration": {
      const sentinels: unknown = ast.annotations?.["~sentinels"];
      return Array.isArray(sentinels) ? (sentinels as Array<Sentinel>) : [];
    }
    case "Objects":
      return ast.propertySignatures.flatMap(({ name, type }) => {
        const literal = SchemaAST.isOptional(type)
          ? undefined
          : literalOf(candidateOf(type));
        return literal === undefined
          ? []
          : [{ key: name, literal: literal.value }];
      });
    case "Arrays":
      return ast.elements.flatMap((element, index) => {
        const literal = SchemaAST.isOptional(element)
          ? undefined
          : literalOf(candidateOf(element));
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

const hasField = (input: object, key: PropertyKey): boolean =>
  Object.hasOwn(input, key) ||
  (key in input &&
    !prototypeKeys.has(typeof key === "number" ? String(key) : key));

const fieldOf = (input: object, key: PropertyKey): unknown =>
  hasField(input, key)
    ? (input as Record<PropertyKey, unknown>)[key]
    : undefined;

const none: ReadonlyArray<number> = [];

/**
 * The members Effect tries for an input when it encodes through a union, in order.
 *
 * @remarks
 * Effect pre-selects a union's members by kind of value and by literal tags before it runs any
 * member, so a member whose tag does not match never runs its encoder, middleware or checks. The
 * index Effect builds for that is internal, so this reads the same facts from the members' ASTs and
 * applies the rules of Effect 4.1.4, which 4.0.7 shares apart from tags named after
 * `Object.prototype` members. `members` are the union's members as encoding parses them. Revisit when
 * a supported Effect changes how it selects union members.
 */
export const candidates = (
  members: ReadonlyArray<SchemaAST.AST>,
): ((input: unknown) => ReadonlyArray<number>) => {
  type Index = [Map<unknown, Set<number>>, Set<number>];
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
        if (hasField(input, key)) {
          const match = byValue.get(fieldOf(input, key));
          if (match === undefined) return fallback(kind);
          for (const index of match) selected.add(index);
          direct = key;
        }
      }
      if (direct === undefined)
        for (const [key, [byValue]] of sentinels)
          if (hasField(input, key))
            for (const index of byValue.get(fieldOf(input, key)) ?? [])
              selected.add(index);
      // A missing key is neutral; an observed one rules out the members that own it and differ.
      for (const [key, [byValue, owners]] of sentinels) {
        if (key === direct || !hasField(input, key)) continue;
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
