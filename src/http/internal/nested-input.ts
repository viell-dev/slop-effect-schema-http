import type { SchemaAST } from "effect";
import { encodedInput } from "./encoded-input.js";

type CaptureTerminal = NonNullable<ReturnType<typeof encodedInput>>;
type Key = string | symbol;

interface Node {
  readonly terminal?: CaptureTerminal;
  readonly names: ReadonlyArray<Key>;
  readonly fields: ReadonlyArray<readonly [Key, Node]>;
}

/** A selected path and write, never another candidate on a later check. */
interface Selected {
  readonly key: Key;
  readonly matches: () => boolean;
}

interface Selection extends Selected {
  readonly written: () => boolean;
}

interface Captured {
  readonly select: (output: unknown) => Selection | undefined;
}

const keyOf = (name: PropertyKey): Key =>
  typeof name === "number" ? String(name) : name;

/** Retain the actual enumerable output link or write, including its object identity. */
const writtenData = (output: unknown, key: Key) => {
  if (
    typeof output !== "object" ||
    output === null ||
    Symbol.iterator in output
  )
    return undefined;
  const prototype: unknown = Object.getPrototypeOf(output);
  const property = Object.getOwnPropertyDescriptor(output, key);
  if (
    property?.enumerable !== true ||
    !("value" in property) ||
    property.value === undefined
  )
    return undefined;
  return {
    value: property.value as unknown,
    matches() {
      try {
        const current = Object.getOwnPropertyDescriptor(output, key);
        return (
          Object.getPrototypeOf(output) === prototype &&
          !(Symbol.iterator in output) &&
          current?.enumerable === true &&
          "value" in current &&
          Object.is(property.value, current.value) &&
          current.writable === property.writable &&
          current.configurable === property.configurable
        );
      } catch {
        return false;
      }
    },
  };
};

/** Data only; capture each shared ancestor prefix once, without copying the caller's values. */
const ownData = (input: unknown, names: ReadonlyArray<Key>) => {
  if (typeof input !== "object" || input === null) return undefined;
  const prototype: unknown = Object.getPrototypeOf(input);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Symbol.iterator in input
  )
    return undefined;
  const keys = Reflect.ownKeys(input);
  const properties = new Map(
    keys.map(
      (key) => [key, Object.getOwnPropertyDescriptor(input, key)!] as const,
    ),
  );
  if (
    [...properties.values()].some(
      (property) => property === undefined || !("value" in property),
    )
  )
    return undefined;
  const absent = names.filter((name) => !properties.has(name));
  if (absent.some((name) => name in input)) return undefined;
  return {
    properties,
    matches() {
      try {
        if (
          Object.getPrototypeOf(input) !== prototype ||
          Symbol.iterator in input ||
          absent.some((name) => name in input)
        )
          return false;
        const currentKeys = Reflect.ownKeys(input);
        return (
          currentKeys.length === keys.length &&
          keys.every((key, index) => {
            const before = properties.get(key)!;
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
};

/**
 * Nested encoded-only evidence through unchanged closed object/union fields. A parent union
 * contributes a field only when every declaring member uses the same schema. No schema or thunk runs.
 */
export const nestedEncodedInput = (ast: SchemaAST.AST) => {
  type Fields = ReadonlyMap<Key, SchemaAST.AST | undefined>;
  const views = new Map<SchemaAST.AST, Fields | undefined>();
  const viewing = new Set<SchemaAST.AST>();
  let cyclic = false;
  const fieldsOf = (part: SchemaAST.AST): Fields | undefined => {
    if (views.has(part)) return views.get(part);
    if (
      part.encoding !== undefined ||
      (part._tag !== "Objects" && part._tag !== "Union") ||
      (part._tag === "Objects" &&
        (part.indexSignatures.length > 0 ||
          part.propertySignatures.some(
            ({ name }) => name === Symbol.iterator,
          ))) ||
      (part._tag === "Union" && part.types.length === 0)
    ) {
      views.set(part, undefined);
      return undefined;
    }
    if (part._tag === "Objects") {
      const fields = new Map(
        part.propertySignatures.map(({ name, type }) => [keyOf(name), type]),
      );
      views.set(part, fields);
      return fields;
    }
    if (viewing.has(part)) {
      cyclic = true;
      return undefined;
    }
    viewing.add(part);
    const fields = new Map<Key, SchemaAST.AST | undefined>();
    for (const member of part.types) {
      const declared = fieldsOf(member);
      if (declared === undefined) {
        viewing.delete(part);
        views.set(part, undefined);
        return undefined;
      }
      for (const [name, type] of declared) {
        if (!fields.has(name)) fields.set(name, type);
        else if (fields.get(name) !== type) fields.set(name, undefined);
      }
    }
    viewing.delete(part);
    views.set(part, fields);
    return fields;
  };
  if (fieldsOf(ast) === undefined) return undefined;
  const known = new Map<SchemaAST.AST, Node | undefined>();
  const active = new Set<SchemaAST.AST>();
  const nodeOf = (part: SchemaAST.AST, root = false): Node | undefined => {
    if (active.has(part)) {
      cyclic = true;
      return undefined;
    }
    if (known.has(part)) return known.get(part);
    const terminal = root ? undefined : encodedInput(part);
    if (terminal !== undefined) {
      const node = { terminal, names: [], fields: [] };
      known.set(part, node);
      return node;
    }
    const declared = fieldsOf(part);
    if (declared === undefined) {
      known.set(part, undefined);
      return undefined;
    }
    active.add(part);
    const fields = [...declared].flatMap(([name, type]) => {
      if (type === undefined) return [];
      const node = nodeOf(type);
      return node === undefined ? [] : [[name, node] as const];
    });
    active.delete(part);
    const node =
      fields.length === 0
        ? undefined
        : {
            names: [...declared.keys()],
            fields,
          };
    known.set(part, node);
    return node;
  };
  const root = nodeOf(ast, true);
  if (root === undefined || cyclic) return undefined;
  const capture = (node: Node, input: unknown): Captured | undefined => {
    if (node.terminal !== undefined) {
      const evidence = node.terminal(input);
      if (evidence === undefined) return undefined;
      return {
        select(output) {
          if (!evidence.matches()) return undefined;
          const key = evidence.witness(output);
          if (key === undefined || !evidence.matches()) return undefined;
          const written = writtenData(output, key);
          return written === undefined
            ? undefined
            : {
                key,
                matches: evidence.matches,
                written: written.matches,
              };
        },
      };
    }
    const data = ownData(input, node.names);
    if (data === undefined) return undefined;
    const children = node.fields.flatMap(([name, child]) => {
      const property = data.properties.get(name);
      const captured =
        property === undefined ? undefined : capture(child, property.value);
      return captured === undefined ? [] : [[name, captured] as const];
    });
    if (children.length === 0) return undefined;
    return {
      select(output) {
        try {
          if (
            !data.matches() ||
            typeof output !== "object" ||
            output === null ||
            Symbol.iterator in output
          )
            return undefined;
          for (const [name, child] of children) {
            const written = writtenData(output, name);
            if (written === undefined) continue;
            const selected = child.select(written.value);
            if (selected !== undefined) {
              return {
                key: selected.key,
                matches: () => selected.matches() && data.matches(),
                // Descendant reflection runs before rechecking the earlier links it may change.
                written: () => selected.written() && written.matches(),
              };
            }
          }
          return undefined;
        } catch {
          return undefined;
        }
      },
    };
  };
  return (input: unknown) => {
    try {
      const captured = capture(root, input);
      if (captured === undefined) return undefined;
      return {
        select(output: unknown): Selected | undefined {
          const selected = captured.select(output);
          // Prove this fixed write once, then retain caller evidence while decoding fresh output.
          return selected !== undefined &&
            selected.written() &&
            selected.matches()
            ? { key: selected.key, matches: selected.matches }
            : undefined;
        },
      };
    } catch {
      return undefined;
    }
  };
};
