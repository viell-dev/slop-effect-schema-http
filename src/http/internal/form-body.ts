import {
  Redacted,
  Schema,
  SchemaAST,
  SchemaGetter,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import { HttpBody, UrlParams } from "effect/http";
import { isBlob, isBox, stateOf } from "./object-brand.js";
import { replaceEncoding } from "./schema-ast.js";
import {
  BodyWriteError,
  bodyError,
  checked,
  checkedBody,
  extraArrayField,
  isBodyWriteError,
  type Path,
} from "./writer-error.js";

/*
 * Rebuilding a schema node keeps its checks, context and annotations only through Effect's own
 * rebuild operations: `SchemaAST.replaceEncoding`, exported but marked internal, and each node's
 * undeclared `recur`, which maps its children and wraps a `Suspend` thunk without forcing it.
 * Both exist with these signatures in Effect 4.0.7 and 4.1.4, the peer floor and the current
 * peer that CI tests; the public API has no operation that replaces one link of an encoding.
 * Reconsider when Effect exposes one, or when a peer update changes either operation.
 */
type Recurring = SchemaAST.AST & {
  recur?: (map: (child: SchemaAST.AST) => SchemaAST.AST) => SchemaAST.AST;
};

/** Writer refusals raised inside Effect's encoding, which Effect carries as schema issues. */
const refusals = new WeakMap<SchemaIssue.Issue, BodyWriteError>();

const issueOf = (error: BodyWriteError): SchemaIssue.Issue => {
  const reason = new SchemaIssue.InvalidValue({ message: error.explanation });
  const issue =
    error.path.length === 0
      ? reason
      : new SchemaIssue.Pointer(error.path, reason);
  refusals.set(issue, error);
  return issue;
};

/**
 * Report a form writer's refusal as the `HttpBodyError` the direct encoders give, with the path
 * from the body's root. Any other schema failure stays a `SchemaError`.
 */
export function encodingError(
  error: Schema.SchemaError,
): Schema.SchemaError | HttpBody.HttpBodyError {
  const find = (
    issue: SchemaIssue.Issue,
    path: Path,
  ): BodyWriteError | undefined => {
    const refusal = refusals.get(issue);
    if (refusal !== undefined)
      return path.length === 0
        ? refusal
        : new BodyWriteError(
            refusal.medium,
            [...path, ...refusal.path],
            refusal.explanation,
          );
    if (issue._tag === "Pointer")
      return find(issue.issue, [...path, ...issue.path]);
    if ("issue" in issue) return find(issue.issue, path);
    if ("issues" in issue)
      for (const child of issue.issues) {
        const found = find(child, path);
        if (found !== undefined) return found;
      }
    return undefined;
  };
  const refusal = find(error.issue, []);
  return refusal === undefined ? error : bodyError(refusal);
}

const tagOf = (value: object): string => Object.prototype.toString.call(value);

/**
 * A form from any implementation or realm, recognized as Fetch implementations recognize one: by
 * its `FormData` tag and its `append` method. It is sent as it is.
 */
const isFormData = (value: unknown): value is FormData =>
  typeof value === "object" &&
  value !== null &&
  tagOf(value) === "[object FormData]" &&
  typeof Reflect.get(value, "append") === "function";

const isSearchParams = (value: unknown): value is URLSearchParams =>
  typeof value === "object" &&
  value !== null &&
  tagOf(value) === "[object URLSearchParams]" &&
  typeof Reflect.get(value, "append") === "function";

const isText = (value: unknown): value is string => typeof value === "string";

/** A record from any realm: its prototype is `null` or a realm's `Object.prototype`. */
const isPlain = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    prototype === null ||
    (typeof prototype === "object" && Object.getPrototypeOf(prototype) === null)
  );
};

/** Text or a Blob, including a File. The tag keeps the throwing brand test off ordinary objects. */
const isPart = (value: unknown): value is string | Blob =>
  typeof value === "string" ||
  (typeof value === "object" &&
    value !== null &&
    (tagOf(value) === "[object Blob]" || tagOf(value) === "[object File]") &&
    isBlob(value));

/** A position in the tree, linked to its parent so deep values share their path. */
interface Step {
  readonly key: PropertyKey;
  readonly parent: Step | undefined;
}

/** The path to a step, collected from the step outwards and reversed once, in linear time. */
const pathOf = (step: Step | undefined): Path => {
  const path: PropertyKey[] = [];
  for (let at = step; at !== undefined; at = at.parent) path.push(at.key);
  return path.toReversed();
};

type Task =
  | {
      readonly kind: "write";
      readonly value: unknown;
      readonly name: string;
      readonly step: Step;
    }
  | { readonly kind: "leave"; readonly container: object };

/** Refuse the pair at a position, or one of its fields. */
type PairRefusal = (
  position: number,
  reason: string,
  field?: PropertyKey,
) => never;

/** Read an iterable of field pairs by position, as `UrlParams.fromInput` reads its entries. */
function pairsOf(input: Iterable<unknown>, refuse: PairRefusal): Field[] {
  const fields: Field[] = [];
  let index = 0;
  for (const pair of input) {
    if (!Array.isArray(pair) || pair.length !== 2)
      refuse(index, "must be a pair");
    const entry = pair as unknown[];
    const extra = extraArrayField(entry, 2);
    if (extra !== undefined)
      refuse(index, "cannot encode an extra array field", extra);
    const name: unknown = entry[0];
    if (typeof name !== "string") refuse(index, "must have a string name", 0);
    fields.push([name as string, entry[1]]);
    index++;
  }
  return fields;
}

/** A named field to write at the root, from a pair rather than a record. */
type Field = readonly [string, unknown];

interface Rules<A> {
  readonly medium: "Multipart" | "URL-encoded";
  readonly isLeaf: (value: unknown) => value is A;
  /** The refusal for a value that is neither a leaf nor a container. */
  readonly leaves: string;
  /**
   * The refusal for a list item that is no leaf, where a list holds leaves only, as
   * `UrlParams.fromInput` converts each item to text. Effect's form links write any other item
   * under an indexed name instead, so they leave this out.
   */
  readonly listItems?: string;
  /** Whether an iterable that is not a list holds field pairs, as `UrlParams.fromInput` reads it. */
  readonly iterablePairs: boolean;
  readonly append: (key: string, value: A) => void;
}

/**
 * Flatten a form tree into entries with the bracket paths and repeated names of Effect's form
 * links, refusing what those links would silently skip.
 *
 * @remarks
 * Each value is read once, in Effect's order: all fields of an object, then each field's
 * entries. A list of leaves repeats its name, and any other list uses indexed names. An empty
 * list or plain object writes no entries, as in Effect. The traversal keeps its own stack, so an
 * exception thrown while it runs came from caller code.
 */
function writeTree<A>(
  input: unknown,
  {
    medium,
    isLeaf,
    leaves: notLeaf,
    listItems,
    iterablePairs,
    append,
  }: Rules<A>,
  fields?: ReadonlyArray<Field>,
): void {
  const refuse = (
    step: Step | undefined,
    reason: string,
    field?: PropertyKey,
  ): never => {
    const path = pathOf(step);
    throw new BodyWriteError(
      medium,
      field === undefined ? path : [...path, field],
      reason,
    );
  };
  const active = new Set<object>();
  const tasks: Task[] = [];

  const enter = (container: object, step: Step | undefined) => {
    if (active.has(container)) refuse(step, "contains circular form data");
    active.add(container);
    tasks.push({ kind: "leave", container });
  };

  const object = (value: object, name: string, step: Step | undefined) => {
    const entries: Array<readonly [string, unknown]> = [];
    let symbol: symbol | undefined;
    for (const key of Reflect.ownKeys(value)) {
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) continue;
      const entry: unknown = Reflect.get(value, key);
      if (entry === undefined) continue;
      if (typeof key === "symbol") symbol ??= key;
      else entries.push([key, entry]);
    }
    if (Array.isArray(value)) {
      const extra = extraArrayField(value, value.length);
      if (extra !== undefined)
        refuse(step, "cannot encode an extra array field", extra);
    } else {
      const fieldless = entries.length === 0 && symbol === undefined;
      const state = stateOf(value, fieldless);
      if (state !== undefined)
        refuse(
          step,
          "cannot encode " +
            (isBox(state) ? "a boxed " + state.toLowerCase() : state),
        );
      // An empty plain object says there are no entries. Another object without fields, such as a
      // `Redacted` value or a class with private state, holds content no form entry can carry.
      if (fieldless && !isPlain(value))
        refuse(step, "has no own fields a form can write");
    }
    if (symbol !== undefined)
      refuse(step, "must have a string field name", symbol);
    enter(value, step);
    for (let index = entries.length - 1; index >= 0; index--) {
      const [key, entry] = entries[index]!;
      tasks.push({
        kind: "write",
        value: entry,
        name: step === undefined ? key : `${name}[${key}]`,
        step: { key, parent: step },
      });
    }
  };

  const list = (values: ReadonlyArray<unknown>, name: string, step: Step) => {
    const length = values.length;
    const extra = extraArrayField(values, length);
    if (extra !== undefined)
      refuse(step, "cannot encode an extra array field", extra);
    const items: Array<readonly [number, unknown]> = [];
    let leaves = true;
    for (let index = 0; index < length; index++) {
      // A hole supplies nothing, as an undefined field does.
      if (!(index in values)) continue;
      const item: unknown = values[index];
      if (item === undefined)
        refuse(step, "cannot encode undefined in a list", index);
      leaves &&= isLeaf(item);
      if (!leaves && listItems !== undefined)
        refuse(
          step,
          typeof item === "object" &&
            item !== null &&
            !Redacted.isRedacted(item)
            ? "cannot encode a list or an object inside a list"
            : listItems,
          index,
        );
      items.push([index, item]);
    }
    if (leaves) {
      for (const [, item] of items) append(name, item as A);
      return;
    }
    enter(values, step);
    for (let at = items.length - 1; at >= 0; at--) {
      const [index, item] = items[at]!;
      tasks.push({
        kind: "write",
        value: item,
        name: `${name}[${index}]`,
        step: { key: index, parent: step },
      });
    }
  };

  /** Write an iterable's pairs as fields under its name, in the order it yields them. */
  const pairs = (value: object, name: string, step: Step) => {
    const read = pairsOf(
      value as Iterable<unknown>,
      (position, reason, field) =>
        refuse({ key: position, parent: step }, reason, field),
    );
    enter(value, step);
    for (let index = read.length - 1; index >= 0; index--) {
      const [key, entry] = read[index]!;
      if (entry !== undefined)
        tasks.push({
          kind: "write",
          value: entry,
          name: `${name}[${key}]`,
          step: { key, parent: step },
        });
    }
  };

  const write = (value: unknown, name: string, step: Step) => {
    if (isLeaf(value)) append(name, value);
    else if (Array.isArray(value)) list(value, name, step);
    else if (
      iterablePairs &&
      typeof value === "object" &&
      value !== null &&
      typeof Reflect.get(value, Symbol.iterator) === "function"
    )
      pairs(value, name, step);
    // A redacted value is a leaf when its value is one; its own object holds no fields.
    else if (Redacted.isRedacted(value)) refuse(step, notLeaf);
    else if (typeof value === "object" && value !== null)
      object(value, name, step);
    else refuse(step, notLeaf);
  };

  if (fields !== undefined) {
    for (let index = fields.length - 1; index >= 0; index--) {
      const [name, value] = fields[index]!;
      // A pair's undefined value supplies nothing, as Effect's reading of field pairs skips it.
      if (value !== undefined)
        tasks.push({
          kind: "write",
          value,
          name,
          step: { key: name, parent: undefined },
        });
    }
  } else if (typeof input !== "object" || input === null)
    refuse(undefined, "must be a form object");
  else object(input, "", undefined);
  while (tasks.length > 0) {
    const task = tasks.pop()!;
    if (task.kind === "leave") active.delete(task.container);
    else write(task.value, task.name, task.step);
  }
}

const multipart = new SchemaTransformation.Transformation(
  SchemaTransformation.fromFormData.decode,
  SchemaGetter.transformEffect((input: unknown) =>
    checked(
      () => {
        // A schema can keep an already prepared form, from any implementation.
        if (isFormData(input)) return input;
        const form = new FormData();
        writeTree(input, {
          medium: "Multipart",
          isLeaf: isPart,
          leaves: "must be text, a Blob or File, or a form container",
          iterablePairs: false,
          append: (key, value) => form.append(key, value),
        });
        return form;
      },
      isBodyWriteError,
      issueOf,
    ),
  ),
);

const searchParams = new SchemaTransformation.Transformation(
  SchemaTransformation.fromURLSearchParams.decode,
  SchemaGetter.transformEffect((input: unknown) =>
    checked(
      () => {
        if (isSearchParams(input)) return input;
        const params = new URLSearchParams();
        writeTree(input, {
          medium: "URL-encoded",
          isLeaf: isText,
          leaves: "must be text or a form container",
          iterablePairs: false,
          append: (key, value) => params.append(key, value),
        });
        return params;
      },
      isBodyWriteError,
      issueOf,
    ),
  ),
);

const preparedForm = Schema.declare(isFormData).ast;
const preparedSearchParams = Schema.declare(isSearchParams).ast;

/** Put checked versions of Effect's form writers where Effect's own encoding invokes them. */
export const codec = <S extends Schema.Top>(schema: S): S => {
  const cache = new WeakMap<SchemaAST.AST, SchemaAST.AST>();
  const replace = (ast: SchemaAST.AST): SchemaAST.AST => {
    const existing = cache.get(ast);
    if (existing !== undefined) return existing;
    const encoding =
      ast.encoding &&
      (SchemaAST.mapOrSame(ast.encoding, (link) => {
        if (link.transformation === SchemaTransformation.fromFormData)
          return new SchemaAST.Link(
            link.to === Schema.FormData.ast ? preparedForm : replace(link.to),
            multipart,
          );
        if (link.transformation === SchemaTransformation.fromURLSearchParams)
          return new SchemaAST.Link(
            link.to === Schema.URLSearchParams.ast
              ? preparedSearchParams
              : replace(link.to),
            searchParams,
          );
        const target = replace(link.to);
        return target === link.to
          ? link
          : new SchemaAST.Link(target, link.transformation);
      }) as SchemaAST.Encoding);
    const body = (ast as Recurring).recur?.call(ast, replace) ?? ast;
    const result =
      body === ast && encoding === ast.encoding
        ? ast
        : replaceEncoding(body, encoding);
    cache.set(ast, result);
    return result;
  };
  const ast = replace(schema.ast);
  return ast === schema.ast ? schema : Schema.make<S>(ast);
};

/** The direct multipart writer. It sends a prepared form as it is. */
export const encodeFormData = (input: FormData) =>
  checkedBody(() => {
    if (!isFormData(input))
      throw new BodyWriteError("Multipart", [], "must be FormData");
    return HttpBody.formData(input);
  });

const refuseParams = (path: Path, reason: string): never => {
  throw new BodyWriteError("URL-encoded", path, reason);
};

/** A value `UrlParams` writes as its text: text, a number, a bigint, a boolean, or one redacted. */
type Param = string | number | bigint | boolean | Redacted.Redacted;

const isScalar = (
  value: unknown,
): value is string | number | bigint | boolean =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "bigint" ||
  typeof value === "boolean";

const isParam = (value: unknown): value is Param =>
  isScalar(value) ||
  (Redacted.isRedacted(value) && isScalar(Redacted.value(value)));

const paramText = (value: Param): string =>
  String(Redacted.isRedacted(value) ? Redacted.value(value) : value);

const atPair: PairRefusal = (position, reason, field) =>
  refuseParams(field === undefined ? [position] : [position, field], reason);

/**
 * The direct URL-encoded writer.
 *
 * @remarks
 * `UrlParams` values write their pairs as they are. Anything else is read as Effect's
 * `UrlParams.fromInput` reads it, which is what 0.18.0 sent: a record by its fields, with nested
 * records under bracket names and lists as repeated names, and an iterable, such as
 * `URLSearchParams` or a `Map`, by its pairs, at the root or nested. Every value is then checked as the form writers check theirs:
 * text and the scalars `UrlParams` writes as text are kept, and a value Effect would drop or write
 * as something else, such as `null`, a `Date` or a list inside a list, is refused.
 */
export const encodeUrlParams = (input: unknown) =>
  checkedBody(() => {
    const params = new URLSearchParams();
    const rules: Rules<Param> = {
      medium: "URL-encoded",
      isLeaf: isParam,
      leaves:
        "must be text, a number, a bigint, a boolean, or a record of them",
      listItems: "must be text, a number, a bigint or a boolean",
      iterablePairs: true,
      append: (key, value) => params.append(key, paramText(value)),
    };
    const value: unknown = input;
    if (UrlParams.isUrlParams(value)) {
      const pairs: unknown = value.params;
      if (!Array.isArray(pairs))
        return refuseParams([], "must contain an array of pairs");
      const extra = extraArrayField(pairs, pairs.length);
      if (extra !== undefined)
        refuseParams([extra], "cannot encode an extra array field");
      const positions = Array.from(
        { length: pairs.length },
        (_, index): unknown => pairs[index],
      );
      // `UrlParams` writes each value with no nesting, so a value has to be text already.
      for (const [name, param] of pairsOf(positions, atPair))
        if (isParam(param)) rules.append(name, param);
        else
          refuseParams([name], "must be text, a number, a bigint or a boolean");
    } else if (typeof value !== "object" || value === null)
      refuseParams([], "must be UrlParams, a record or field pairs");
    else if (typeof Reflect.get(value, Symbol.iterator) === "function") {
      // A list of pairs is read by its iterator, which a field beside its positions never reaches.
      if (Array.isArray(value)) {
        const extra = extraArrayField(value, value.length);
        if (extra !== undefined)
          refuseParams([extra], "cannot encode an extra array field");
      }
      writeTree(value, rules, pairsOf(value as Iterable<unknown>, atPair));
    } else writeTree(value, rules);
    return HttpBody.text(
      params.toString(),
      "application/x-www-form-urlencoded",
    );
  });
