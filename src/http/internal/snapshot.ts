import type { SchemaAST } from "effect";

interface Snapshot {
  readonly value: unknown;
}

/** Static visible sides only: capturing evidence must never evaluate a suspended schema. */
const sidesOf = (
  types: ReadonlyArray<SchemaAST.AST>,
): ReadonlyArray<SchemaAST.AST> | undefined => {
  const sides: SchemaAST.AST[] = [];
  for (const type of types) {
    if (type._tag === "Suspend") return undefined;
    const inner = sidesOf([
      ...(type._tag === "Union" ? type.types : []),
      ...(type.encoding ?? []).map(({ to }) => to),
    ]);
    if (inner === undefined) return undefined;
    sides.push(type, ...inner);
  }
  return sides;
};

const describe = (types: ReadonlyArray<SchemaAST.AST>) => {
  const sides = sidesOf(types);
  if (sides === undefined) return undefined;
  const objects = sides.filter((side) => side._tag === "Objects");
  const arrays = sides.filter((side) => side._tag === "Arrays");
  const fields = objects.flatMap((side) => side.propertySignatures);
  const rest = [
    ...objects.flatMap((side) => side.indexSignatures.map(({ type }) => type)),
    ...arrays.flatMap((side) => side.rest),
  ];
  const children = new Map<PropertyKey, ReadonlyArray<SchemaAST.AST>>();
  const onlyRest =
    fields.length === 0 && arrays.every((side) => side.elements.length === 0);
  return {
    unsafe:
      sides.some(({ _tag }) =>
        ["Any", "Unknown", "ObjectKeyword"].includes(_tag),
      ) ||
      ((objects.length > 0 || arrays.length > 0) &&
        sides.some(({ _tag }) => _tag === "Declaration")),
    visible: objects.length > 0 || arrays.length > 0,
    names: fields.map(({ name }) => name),
    child(key: PropertyKey) {
      if (onlyRest) return rest;
      const known = children.get(key);
      if (known !== undefined) return known;
      const fixed = arrays.flatMap((side) => {
        const element =
          typeof key === "symbol" ? undefined : side.elements[Number(key)];
        return element === undefined ? [] : [element];
      });
      if (!fields.some(({ name }) => name === key) && fixed.length === 0)
        return rest;
      const inner = [
        ...fields.filter(({ name }) => name === key).map(({ type }) => type),
        ...fixed,
        ...rest,
      ];
      children.set(key, inner);
      return inner;
    },
  };
};
/**
 * Copy visible data before callbacks can mutate it. Opaque values keep their identity. Accessors,
 * inherited fields, shared references, open or declared/structural mixtures, nonplain visible
 * objects and suspended structure provide no safe snapshot. Reuse only schema metadata; no caller
 * value belongs in the cache.
 */
export const snapshotter = (schemaTypes: ReadonlyArray<SchemaAST.AST>) => {
  const metadata = new Map<
    ReadonlyArray<SchemaAST.AST>,
    ReturnType<typeof describe>
  >();
  const copy = (
    types: ReadonlyArray<SchemaAST.AST>,
    value: unknown,
    seen: Set<object>,
  ): Snapshot | undefined => {
    if (typeof value !== "object" || value === null) return { value };
    if (seen.has(value)) return undefined;
    seen.add(value);
    if (!metadata.has(types)) metadata.set(types, describe(types));
    const shape = metadata.get(types);
    if (shape === undefined || shape.unsafe) return undefined;
    if (!shape.visible) return { value };
    const list = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      (!list && prototype !== Object.prototype && prototype !== null) ||
      (!list && Symbol.iterator in value)
    )
      return undefined;
    const descriptors: Record<PropertyKey, PropertyDescriptor> =
      Object.getOwnPropertyDescriptors(value);
    if (
      shape.names.some(
        (name) => !Object.hasOwn(descriptors, name) && name in value,
      )
    )
      return undefined;
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor)) return undefined;
      const next = copy(shape.child(key), descriptor.value, seen);
      if (next === undefined) return undefined;
      descriptor.value = next.value;
    }
    return {
      value: list
        ? Object.defineProperties([], descriptors)
        : Object.create(prototype as object | null, descriptors),
    };
  };
  return (input: unknown) => copy(schemaTypes, input, new Set());
};
