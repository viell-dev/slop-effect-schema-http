import type { SchemaAST } from "effect";
import { encodedInput, metadata } from "./encoded-input.js";
import type { AliasAlternative } from "./void-member.js";

type CaptureTerminal = NonNullable<ReturnType<typeof encodedInput>>;
type Key = string | symbol;

interface Positions {
  readonly names: ReadonlyArray<Key>;
  readonly elements: ReadonlyArray<Node | undefined>;
  readonly rest: ReadonlyArray<Node | undefined>;
}

/** An object cell reads the terminal or fields; an actual array cell reads the positions. */
interface Node {
  readonly terminal: CaptureTerminal | undefined;
  readonly names: ReadonlyArray<Key>;
  readonly fields: ReadonlyArray<readonly [Key, Node]>;
  /** The fields view left out an array member, so it cannot vouch for a list cell. */
  readonly lists: boolean;
  readonly array: Positions | undefined;
}

/** A selected path and write, never another candidate on a later check. */
interface Selected {
  readonly key: Key;
  readonly path: ReadonlyArray<PropertyKey>;
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

/** Canonical own positions only: symbols and index-looking metadata never become array cells. */
const arrayIndex = (key: Key, length: number): number | undefined => {
  if (typeof key !== "string") return undefined;
  const index = Number(key);
  return Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
    ? index
    : undefined;
};

const arrayIterator: unknown = Object.getOwnPropertyDescriptor(
  Array.prototype,
  Symbol.iterator,
)?.value;

const nativeIteratorUnchanged = (): boolean => {
  const current = Object.getOwnPropertyDescriptor(
    Array.prototype,
    Symbol.iterator,
  );
  return (
    typeof arrayIterator === "function" &&
    current !== undefined &&
    "value" in current &&
    current.value === arrayIterator
  );
};

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
const ownData = (
  input: unknown,
  names: ReadonlyArray<Key>,
  array: false | "caller" | "output" = false,
) => {
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
  const ownIterator = properties.get(Symbol.iterator);
  const iteratorAllowed = () =>
    ownIterator === undefined ||
    (array === "caller" &&
      ownIterator.value === arrayIterator &&
      nativeIteratorUnchanged());
  const length: unknown = array ? properties.get("length")?.value : undefined;
  if (
    array &&
    (typeof length !== "number" ||
      !Number.isInteger(length) ||
      length < 0 ||
      length > 0xffff_ffff ||
      !iteratorAllowed() ||
      (array === "output" &&
        keys.filter((key) => arrayIndex(key, length) !== undefined).length !==
          length))
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
          (array && !iteratorAllowed()) ||
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
 * Nested encoded-only evidence through unchanged object/union fields and own array positions.
 * A parent union contributes a field only when every declaring member uses the same schema, and
 * passes an actual array cell only to its one member that can read arrays. No schema or thunk runs.
 */
export const nestedEncodedInput = (
  ast: SchemaAST.AST,
  isAlternative?: AliasAlternative,
) => {
  // Every node is classified and named once per build, however many ancestors share it.
  const context = metadata(isAlternative);
  type Fields = ReadonlyMap<Key, SchemaAST.AST | undefined>;
  interface View {
    readonly fields: Fields;
    readonly lists: boolean;
  }
  const mergeField = (
    fields: Map<Key, SchemaAST.AST | undefined>,
    name: PropertyKey,
    type: SchemaAST.AST | undefined,
  ) => {
    const key = keyOf(name);
    if (!fields.has(key)) fields.set(key, type);
    else if (fields.get(key) !== type) fields.set(key, undefined);
  };
  const views = new Map<SchemaAST.AST, View | undefined>();
  const viewing = new Set<SchemaAST.AST>();
  let cyclic = false;
  const fieldsOf = (part: SchemaAST.AST): View | undefined => {
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
      const view = { fields, lists: false };
      views.set(part, view);
      return view;
    }
    if (viewing.has(part)) {
      cyclic = true;
      return undefined;
    }
    viewing.add(part);
    const fields = new Map<Key, SchemaAST.AST | undefined>();
    let hasObjectMember = false;
    let lists = false;
    for (const member of part.types) {
      // An object cell cannot reach this member. A list can, unless the member refuses lists too.
      if (context.refuses(part, member, "record")) {
        lists ||= !context.refuses(part, member, "array");
        continue;
      }
      const declared = fieldsOf(member);
      if (declared === undefined) {
        viewing.delete(part);
        views.set(part, undefined);
        return undefined;
      }
      hasObjectMember = true;
      lists ||= declared.lists;
      for (const [name, type] of declared.fields)
        mergeField(fields, name, type);
    }
    viewing.delete(part);
    // Match the terminal view: a primitive-only union never becomes an empty object view.
    const view = hasObjectMember ? { fields, lists } : undefined;
    views.set(part, view);
    return view;
  };
  const known = new Map<SchemaAST.AST, Node | undefined>();
  const active = new Set<SchemaAST.AST>();
  const placed = new Map<SchemaAST.AST, Positions | undefined>();
  /** Positions alone, so a chain of unions never builds its intermediate object views. */
  const positionsOf = (part: SchemaAST.AST): Positions | undefined => {
    if (placed.has(part)) return placed.get(part);
    const positions = locate(part);
    placed.set(part, positions);
    return positions;
  };
  const locate = (part: SchemaAST.AST): Positions | undefined => {
    if (part.encoding !== undefined) return undefined;
    if (part._tag === "Union") {
      // An actual array cell reaches the union's one member Effect's parsers let read an array.
      // A guarded Void branch declines a list whose own cells it reads as defined, which every
      // cell captured here is, unless a proxy answers that read differently from its descriptor.
      const readers = part.types.filter(
        (member) => !context.refuses(part, member, "array"),
      );
      const reader = readers.length === 1 ? readers[0]! : undefined;
      if (reader === undefined) return undefined;
      if (active.has(reader)) {
        cyclic = true;
        return undefined;
      }
      active.add(reader);
      const positions = positionsOf(reader);
      active.delete(reader);
      return positions;
    }
    if (part._tag !== "Arrays") return undefined;
    const elements = part.elements.map((element) => nodeOf(element));
    const rest = part.rest.map((element) => nodeOf(element));
    return elements.every((element) => element === undefined) &&
      rest.every((element) => element === undefined)
      ? undefined
      : {
          names: Array.from(
            { length: elements.length + Math.max(0, rest.length - 1) },
            (_, index) => String(index),
          ),
          elements,
          rest,
        };
  };
  const nodeOf = (part: SchemaAST.AST, root = false): Node | undefined => {
    if (active.has(part)) {
      cyclic = true;
      return undefined;
    }
    if (known.has(part)) return known.get(part);
    active.add(part);
    const array = positionsOf(part);
    const terminal = root
      ? undefined
      : encodedInput(part, context.isAlternative, context);
    const declared = terminal === undefined ? fieldsOf(part) : undefined;
    const fields = [...(declared?.fields ?? [])].flatMap(([name, type]) => {
      if (type === undefined) return [];
      const node = nodeOf(type);
      return node === undefined ? [] : [[name, node] as const];
    });
    active.delete(part);
    const node =
      terminal === undefined && fields.length === 0 && array === undefined
        ? undefined
        : {
            terminal,
            names: fields.length === 0 ? [] : [...declared!.fields.keys()],
            fields,
            lists: declared?.lists ?? false,
            array,
          };
    known.set(part, node);
    return node;
  };
  const root = nodeOf(ast, true);
  if (root === undefined || cyclic) return undefined;
  const capture = (node: Node, input: unknown): Captured | undefined => {
    // Effect's array and object parsers tell cells apart with `Array.isArray`, which sees through
    // proxies and never runs caller code. A list reads the array view where there is one. Without
    // one it keeps the object reading, unless that view left out an array member.
    const list = Array.isArray(input);
    const positions = list ? node.array : undefined;
    if (positions === undefined && list && node.lists) return undefined;
    if (positions === undefined && node.terminal !== undefined) {
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
                path: [key],
                matches: evidence.matches,
                written: written.matches,
              };
        },
      };
    }
    if (positions === undefined && node.fields.length === 0) return undefined;
    const names = positions?.names ?? node.names;
    const data = ownData(
      input,
      names,
      positions === undefined ? false : "caller",
    );
    if (data === undefined) return undefined;
    const fields = positions
      ? Array.from(data.properties.keys()).flatMap((name) => {
          const index = arrayIndex(name, data.length!);
          if (index === undefined) return [];
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
          return child === undefined ? [] : [[name, child] as const];
        })
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
            ? ownData(output, names, "output")
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
                path: [
                  positions === undefined ? name : Number(name),
                  ...selected.path,
                ],
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
            ? {
                key: selected.key,
                path: selected.path,
                matches: selected.matches,
              }
            : undefined;
        },
      };
    } catch {
      return undefined;
    }
  };
};
