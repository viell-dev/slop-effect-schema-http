import type { SchemaAST } from "effect";
import { encodedInput } from "./encoded-input.js";

type CaptureTerminal = NonNullable<ReturnType<typeof encodedInput>>;
type Key = string | symbol;

interface Node {
  readonly terminal?: CaptureTerminal;
  readonly names: ReadonlyArray<Key>;
  readonly fields: ReadonlyArray<readonly [Key, Node]>;
  readonly array?: {
    readonly elements: ReadonlyArray<Node | undefined>;
    readonly rest: ReadonlyArray<Node | undefined>;
  };
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
const writtenData = (output: unknown, key: Key, array = false) => {
  if (
    typeof output !== "object" ||
    output === null ||
    (array ? !Array.isArray(output) : Symbol.iterator in output)
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
          (array ? Array.isArray(output) : !(Symbol.iterator in output)) &&
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
const ownData = (input: unknown, names: ReadonlyArray<Key>, array = false) => {
  if (typeof input !== "object" || input === null) return undefined;
  const prototype: unknown = Object.getPrototypeOf(input);
  if (
    (prototype !== (array ? Array.prototype : Object.prototype) &&
      prototype !== null) ||
    (array ? !Array.isArray(input) : Symbol.iterator in input)
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
  const length: unknown = array ? properties.get("length")?.value : undefined;
  if (
    array &&
    (typeof length !== "number" ||
      !Number.isInteger(length) ||
      length < 0 ||
      length > 0xffff_ffff ||
      properties.has(Symbol.iterator) ||
      keys.filter((key) => {
        if (typeof key !== "string") return false;
        const index = Number(key);
        return (
          Number.isInteger(index) &&
          index >= 0 &&
          index < length &&
          String(index) === key
        );
      }).length !== length)
  )
    return undefined;
  const absent = names.filter((name) => !properties.has(name));
  if (absent.some((name) => name in input)) return undefined;
  return {
    properties,
    length: length as number | undefined,
    matches() {
      try {
        if (
          Object.getPrototypeOf(input) !== prototype ||
          (array ? !Array.isArray(input) : Symbol.iterator in input) ||
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
 * Nested encoded-only evidence through unchanged object/union fields and dense array positions.
 * A parent union contributes a field only when every declaring member uses the same schema.
 * No schema or thunk runs.
 */
export const nestedEncodedInput = (ast: SchemaAST.AST) => {
  type Fields = ReadonlyMap<Key, SchemaAST.AST | undefined>;
  const mergeField = (
    fields: Map<Key, SchemaAST.AST | undefined>,
    name: PropertyKey,
    type: SchemaAST.AST | undefined,
  ) => {
    const key = keyOf(name);
    if (!fields.has(key)) fields.set(key, type);
    else if (fields.get(key) !== type) fields.set(key, undefined);
  };
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
      const fields = new Map<Key, SchemaAST.AST | undefined>();
      for (const { name, type } of part.propertySignatures)
        mergeField(fields, name, type);
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
      for (const [name, type] of declared) mergeField(fields, name, type);
    }
    viewing.delete(part);
    views.set(part, fields);
    return fields;
  };
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
    if (part._tag === "Arrays" && part.encoding === undefined) {
      active.add(part);
      const elements = part.elements.map((element) => nodeOf(element));
      const rest = part.rest.map((element) => nodeOf(element));
      active.delete(part);
      const node =
        elements.every((element) => element === undefined) &&
        rest.every((element) => element === undefined)
          ? undefined
          : {
              names: Array.from(
                { length: elements.length + Math.max(0, rest.length - 1) },
                (_, index) => String(index),
              ),
              fields: [],
              array: { elements, rest },
            };
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
    const positions = node.array;
    const data = ownData(input, node.names, positions !== undefined);
    if (data === undefined) return undefined;
    const fields = positions
      ? Array.from({ length: data.length! }, (_, index) => {
          const tail = Math.max(
            positions.elements.length,
            data.length! - Math.max(0, positions.rest.length - 1),
          );
          const child =
            index < positions.elements.length
              ? positions.elements[index]
              : index >= tail
                ? positions.rest[index - tail + 1]
                : positions.rest[0];
          return child === undefined ? [] : [[String(index), child] as const];
        }).flat()
      : node.fields;
    const children = fields.flatMap(([name, child]) => {
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
            (positions ? !Array.isArray(output) : Symbol.iterator in output)
          )
            return undefined;
          const arrayOutput = positions
            ? ownData(output, node.names, true)
            : undefined;
          if (
            positions &&
            (arrayOutput === undefined || arrayOutput.length !== data.length)
          )
            return undefined;
          for (const [name, child] of children) {
            const written = writtenData(output, name, positions !== undefined);
            if (written === undefined) continue;
            const selected = child.select(written.value);
            if (selected !== undefined) {
              return {
                key: selected.key,
                matches: () => selected.matches() && data.matches(),
                // Descendant reflection runs before rechecking the earlier links it may change.
                written: () =>
                  selected.written() &&
                  written.matches() &&
                  (arrayOutput === undefined || arrayOutput.matches()),
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
