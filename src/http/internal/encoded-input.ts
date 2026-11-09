import type { SchemaAST } from "effect";

interface Names {
  readonly decoded: ReadonlySet<PropertyKey>;
  readonly encoded: ReadonlySet<PropertyKey>;
  readonly all: ReadonlySet<PropertyKey>;
}

/** JavaScript stores numeric property names as strings; symbols retain their identity. */
const keyOf = (name: PropertyKey): string | symbol =>
  typeof name === "number" ? String(name) : name;

/** Root names only, through closed group nodes, without evaluating a schema or suspension. */
const namesOf = (
  ast: SchemaAST.AST,
  active = new Set<SchemaAST.AST>(),
  known = new Map<SchemaAST.AST, Names | undefined>(),
): Names | undefined => {
  if (known.has(ast)) return known.get(ast);
  if (
    active.has(ast) ||
    (ast._tag !== "Objects" && ast._tag !== "Union") ||
    (ast._tag === "Objects" &&
      (ast.indexSignatures.length > 0 ||
        ast.propertySignatures.some(({ name }) => name === Symbol.iterator))) ||
    (ast._tag === "Union" && ast.types.length === 0)
  )
    return undefined;
  active.add(ast);
  const members: Names[] = [];
  const encodings: Names[] = [];
  for (const [nodes, output] of [
    [ast._tag === "Union" ? ast.types : [], members],
    [(ast.encoding ?? []).map(({ to }) => to), encodings],
  ] as const) {
    for (const node of nodes) {
      const names = namesOf(node, active, known);
      if (names === undefined) {
        active.delete(ast);
        known.set(ast, undefined);
        return undefined;
      }
      output.push(names);
    }
  }
  active.delete(ast);
  const decoded = new Set(
    ast._tag === "Objects"
      ? ast.propertySignatures.map(({ name }) => keyOf(name))
      : members.flatMap(({ decoded: memberNames }) => [...memberNames]),
  );
  const names: Names = {
    decoded,
    encoded:
      encodings.at(-1)?.encoded ??
      (ast._tag === "Objects"
        ? decoded
        : new Set(members.flatMap(({ encoded }) => [...encoded]))),
    all: new Set([
      ...decoded,
      ...[...members, ...encodings].flatMap(({ all }) => [...all]),
    ]),
  };
  known.set(ast, names);
  return names;
};

/**
 * Capture proof that a root field belongs only to the encoded side. This says nothing about alias
 * correspondence or value equality. Any supplied decoded-only name leaves the side ambiguous.
 * Data descriptors, key order, prototype and inherited endpoint absence must remain unchanged.
 */
export const encodedInput = (ast: SchemaAST.AST) => {
  const names = namesOf(ast);
  if (names === undefined) return undefined;
  const encodedOnly = new Set(
    [...names.encoded].filter((name) => !names.decoded.has(name)),
  );
  if (encodedOnly.size === 0) return undefined;
  const decodedOnly = new Set(
    [...names.decoded].filter((name) => !names.encoded.has(name)),
  );
  const allNames = [...names.all];
  return (input: unknown) => {
    if (typeof input !== "object" || input === null) return undefined;
    try {
      const prototype: unknown = Object.getPrototypeOf(input);
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        Symbol.iterator in input
      )
        return undefined;
      const keys = Reflect.ownKeys(input);
      const properties = keys.map(
        (key) => [key, Object.getOwnPropertyDescriptor(input, key)!] as const,
      );
      if (
        properties.some(([, property]) => !("value" in property)) ||
        properties.some(
          ([key, property]) =>
            decodedOnly.has(key) && property.value !== undefined,
        ) ||
        !properties.some(
          ([key, property]) =>
            encodedOnly.has(key) && property.value !== undefined,
        )
      )
        return undefined;
      const inherited = () =>
        allNames.some((name) => !Object.hasOwn(input, name) && name in input);
      if (inherited()) return undefined;
      const witness = (output: unknown): string | symbol | undefined => {
        try {
          if (
            typeof output !== "object" ||
            output === null ||
            Symbol.iterator in output
          )
            return undefined;
          return properties.find(([key, property]) => {
            if (!encodedOnly.has(key) || property.value === undefined)
              return false;
            const written = Object.getOwnPropertyDescriptor(output, key);
            return (
              written?.enumerable === true &&
              "value" in written &&
              written.value !== undefined
            );
          })?.[0];
        } catch {
          return undefined;
        }
      };
      return {
        witness,
        written(output: unknown) {
          return witness(output) !== undefined;
        },
        matches() {
          try {
            if (
              Object.getPrototypeOf(input) !== prototype ||
              Symbol.iterator in input ||
              inherited()
            )
              return false;
            const currentKeys = Reflect.ownKeys(input);
            return (
              currentKeys.length === keys.length &&
              properties.every(([key, before], index) => {
                const after = Object.getOwnPropertyDescriptor(input, key);
                return (
                  key === currentKeys[index] &&
                  after !== undefined &&
                  "value" in after &&
                  Object.is(before.value, after.value) &&
                  before.enumerable === after.enumerable &&
                  before.writable === after.writable &&
                  before.configurable === after.configurable
                );
              })
            );
          } catch {
            return false;
          }
        },
      };
    } catch {
      // Failed reflection supplies no evidence; the ordinary reader retains its behavior.
      return undefined;
    }
  };
};
