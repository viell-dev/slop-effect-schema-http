import type { SchemaAST } from "effect";
import { shapes, type Cell, type Shapes } from "./primitive.js";
import type { AliasAlternative } from "./void-member.js";

export interface Names {
  readonly decoded: ReadonlySet<PropertyKey>;
  readonly encoded: ReadonlySet<PropertyKey>;
  readonly all: ReadonlySet<PropertyKey>;
  /** The view left out an array member, which can still read a list as Effect reads it. */
  readonly lists: boolean;
}

/** Shape and name results one metadata build shares; each depends on the AST alone. */
export interface Metadata {
  readonly shapes: Shapes;
  /**
   * A member that can consume neither an object nor a list at this union: a primitive, or a
   * guarded Void branch, which declines an object or list with a defined field or cell.
   */
  readonly isAlternative: AliasAlternative;
  /**
   * Whether a member of this union cannot consume this kind of cell. An unencoded any-of member
   * union refuses when each of its own members does, with its own guard deciding its Void branches.
   */
  readonly refuses: (
    union: SchemaAST.AST,
    member: SchemaAST.AST,
    cell: Cell,
  ) => boolean;
  readonly names: Map<SchemaAST.AST, Names | undefined>;
}

export const metadata = (isAlternative?: AliasAlternative): Metadata => {
  const known = shapes();
  const alternative: AliasAlternative =
    isAlternative ??
    ((_union, member) => known.record(member) && known.array(member));
  const groups = {
    record: new Map<SchemaAST.AST, boolean>(),
    array: new Map<SchemaAST.AST, boolean>(),
  };
  const grouped = (group: SchemaAST.Union, cell: Cell): boolean => {
    const memo = groups[cell];
    const cached = memo.get(group);
    if (cached !== undefined) return cached;
    // Only a mutated AST forms a cycle. Seeding false declines it when it is reached again.
    memo.set(group, false);
    const result = group.types.every((inner) =>
      refuses(group, inner, cell, true),
    );
    memo.set(group, result);
    return result;
  };
  // The group's own guard counts only if it guarded every occurrence of the group.
  const refuses = (
    union: SchemaAST.AST,
    member: SchemaAST.AST,
    cell: Cell,
    inGroup = false,
  ): boolean =>
    alternative(union, member, inGroup) ||
    known[cell](member) ||
    (member._tag === "Union" &&
      member.encoding === undefined &&
      (member.options?.mode ?? "anyOf") === "anyOf" &&
      grouped(member, cell));
  return {
    shapes: known,
    isAlternative: alternative,
    refuses,
    names: new Map(),
  };
};

/** JavaScript stores numeric property names as strings; symbols retain their identity. */
const keyOf = (name: PropertyKey): string | symbol =>
  typeof name === "number" ? String(name) : name;

/** Root names only, through closed group nodes, without evaluating a schema or suspension. */
const namesOf = (
  ast: SchemaAST.AST,
  context: Metadata,
  active = new Set<SchemaAST.AST>(),
): Names | undefined => {
  const known = context.names;
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
  let lists = false;
  for (const [nodes, output] of [
    [ast._tag === "Union" ? ast.types : [], members],
    [(ast.encoding ?? []).map(({ to }) => to), encodings],
  ] as const) {
    for (const node of nodes) {
      // This is only a union-member rule. Primitive encoding intermediates remain unsupported,
      // and never enter the shared memo as an empty group view.
      if (output === members && context.refuses(ast, node, "record")) {
        // A member that can still read a list keeps this view from vouching for one.
        lists ||= !context.refuses(ast, node, "array");
        continue;
      }
      const names = namesOf(node, context, active);
      if (names === undefined) {
        active.delete(ast);
        known.set(ast, undefined);
        return undefined;
      }
      output.push(names);
    }
  }
  active.delete(ast);
  // A union of primitives is still a primitive encoding intermediate. Requiring an object view
  // also prevents the shared memo from turning that intermediate into an empty group view.
  if (ast._tag === "Union" && members.length === 0) {
    known.set(ast, undefined);
    return undefined;
  }
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
    lists: lists || [...members, ...encodings].some((view) => view.lists),
  };
  known.set(ast, names);
  return names;
};

/**
 * Capture proof that a root field belongs only to the encoded side. This says nothing about alias
 * correspondence or value equality. Any supplied decoded-only name leaves the side ambiguous.
 * Data descriptors, key order, prototype and inherited endpoint absence must remain unchanged.
 */
export const encodedInput = (
  ast: SchemaAST.AST,
  isAlternative?: AliasAlternative,
  context = metadata(isAlternative),
) => {
  const names = namesOf(ast, context);
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
      // Effect's array parser reads what `Array.isArray` accepts, proxies included, so a view that
      // left out an array member cannot vouch for a list. Otherwise a list keeps its evidence: the
      // fieldwise route copies its own named properties into an object.
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        (names.lists && Array.isArray(input)) ||
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
