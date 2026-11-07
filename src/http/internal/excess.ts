import { Schema, SchemaAST, SchemaIssue } from "effect";

/** Where a key sits in a value, one step for each level. */
type Path = ReadonlyArray<PropertyKey>;

/** Parse options that make a schema refuse what it would strip. */
export const strict: SchemaAST.ParseOptions = { onExcessProperty: "error" };

/**
 * The same, and report all of it, which the readers here need. A member that is refused goes on to
 * run its fields, so a value that passes is better read with {@link strict}.
 */
export const complete: SchemaAST.ParseOptions = { ...strict, errors: "all" };

const samePath =
  (left: Path) =>
  (right: Path): boolean =>
    left.length === right.length &&
    left.every((key, index) => key === right[index]);

const partsOf = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> => {
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
const readsKeys = (ast: SchemaAST.AST): boolean =>
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
export const holdsChoice = (ast: SchemaAST.AST): boolean =>
  ast._tag === "Suspend" ||
  (ast._tag === "Union" && ast.types.filter(readsKeys).length > 1) ||
  partsOf(ast).some(holdsChoice) ||
  (ast.encoding ?? []).some(({ to }) => holdsChoice(to));

/** Stands in for a union in a failure made here. These failures are only read, never reported. */
const routes = new SchemaAST.Union([]);

/** The failure of every route to one value, any of which it may have been meant for. */
export const either = (
  ...failures: ReadonlyArray<Schema.SchemaError>
): Schema.SchemaError =>
  new Schema.SchemaError(
    new SchemaIssue.AnyOf(
      routes,
      failures.map(({ issue }) => issue),
    ),
  );

/** A failure of one field, placed under its name. */
export const atField = (
  name: PropertyKey,
  failure: Schema.SchemaError,
): Schema.SchemaError =>
  new Schema.SchemaError(new SchemaIssue.Pointer([name], failure.issue));

/** The keys every one of these failures refused, leaving out those that read no keys. */
const refusedByAll = (
  issues: ReadonlyArray<SchemaIssue.Issue>,
): ReadonlyArray<Path> | undefined => {
  const [first, ...others] = issues
    .map(refused)
    .filter((paths) => paths !== undefined);
  return first?.filter((path) =>
    others.every((other) => other.some(samePath(path))),
  );
};

/**
 * The keys a failure refused as unexpected, or `undefined` if it stopped before it read any keys, as
 * a class does with a value that is not an instance. Under a union these are the keys every member
 * that read them refused, so none of those members states them. A key on a node with an encoding
 * came out of a transformation, so the caller did not give it.
 */
const refused = (issue: SchemaIssue.Issue): ReadonlyArray<Path> | undefined => {
  switch (issue._tag) {
    case "UnexpectedKey":
      return issue.ast.encoding === undefined ? [[]] : [];
    case "Pointer":
      return (
        refused(issue.issue)?.map((path) => [...issue.path, ...path]) ?? []
      );
    case "Encoding":
      return refused(issue.issue);
    case "Composite":
      return issue.issues.flatMap((part) => refused(part) ?? []);
    case "AnyOf":
      return refusedByAll(issue.issues);
    default:
      return undefined;
  }
};

/**
 * What a schema would strip as a struct strips an excess key: the keys no member states. Taking them
 * out first leaves the keys a choice of member decides.
 */
export const excess = (issue: SchemaIssue.Issue): ReadonlyArray<Path> =>
  refused(issue) ?? [];

/**
 * The fields a parse that strips would lose although a union states them, or `undefined` if
 * stripping would not make this failure pass. Effect takes the first member that fits, so that is
 * the member to ask, and a field it refuses is lost when another member would have held it.
 */
const wouldLose = (
  issue: SchemaIssue.Issue,
): ReadonlyArray<Path> | undefined => {
  switch (issue._tag) {
    case "UnexpectedKey":
      return [];
    case "Pointer":
      return wouldLose(issue.issue)?.map((path) => [...issue.path, ...path]);
    case "Encoding":
      return wouldLose(issue.issue);
    case "Composite": {
      const parts = issue.issues.map(wouldLose);
      return parts.every((part) => part !== undefined)
        ? parts.flat()
        : undefined;
    }
    case "AnyOf": {
      const member = issue.issues.find((part) => wouldLose(part) !== undefined);
      if (member === undefined) return undefined;
      const unstated = refusedByAll(issue.issues) ?? [];
      return [
        ...(wouldLose(member) ?? []),
        ...excess(member).filter((path) => !unstated.some(samePath(path))),
      ];
    }
    default:
      return undefined;
  }
};

/** Whether `path` leads to a key that is there and holds nothing. */
const isUnset = (value: unknown, path: Path): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const [key, ...rest] = path;
  if (key === undefined || !Object.hasOwn(value, key)) return false;
  const next = (value as Record<PropertyKey, unknown>)[key];
  return rest.length === 0 ? next === undefined : isUnset(next, rest);
};

/**
 * The fields of `input` a failure shows would be lost. A key set to `undefined` has no value to
 * lose, so it is not among them. A path that does not lead through the value, as one into a `Map`
 * does not, stays among them.
 */
export const lost = (
  issue: SchemaIssue.Issue,
  input: unknown,
): ReadonlyArray<Path> =>
  (wouldLose(issue) ?? []).filter((path) => !isUnset(input, path));

/** `value` without the key at `path`, leaving the original alone. A list keeps its length. */
export const without = (value: unknown, [key, ...rest]: Path): unknown => {
  if (
    key === undefined ||
    typeof value !== "object" ||
    value === null ||
    !Object.hasOwn(value, key)
  )
    return value;
  const next = (value as Record<PropertyKey, unknown>)[key];
  if (Array.isArray(value))
    return rest.length === 0
      ? value
      : value.with(Number(key), without(next, rest));
  if (rest.length > 0) return { ...value, [key]: without(next, rest) };
  const others = { ...value };
  Reflect.deleteProperty(others, key);
  return others;
};

const notHeld = new SchemaIssue.InvalidValue({
  message: "No union member holds this field with the rest of the value",
});

/** A refusal that names the fields and, like any other schema failure here, leaves out values. */
export const refusal = (
  ast: SchemaAST.AST,
  [first, ...others]: readonly [Path, ...ReadonlyArray<Path>],
): Schema.SchemaError =>
  new Schema.SchemaError(
    new SchemaIssue.Composite(ast, [
      new SchemaIssue.Pointer(first, notHeld),
      ...others.map((path) => new SchemaIssue.Pointer(path, notHeld)),
    ]),
  );
