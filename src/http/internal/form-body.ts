import {
  Redacted,
  Schema,
  SchemaAST,
  SchemaGetter,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import { HttpBody, type UrlParams } from "effect/http";
import { isBlob, isBox, stateOf } from "./object-brand.js";
import {
  BodyWriteError,
  bodyError,
  checked,
  checkedBody,
  extraArrayField,
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
const { replaceEncoding } = SchemaAST as typeof SchemaAST & {
  replaceEncoding(
    ast: SchemaAST.AST,
    encoding: SchemaAST.Encoding | undefined,
  ): SchemaAST.AST;
};

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

const pathOf = (step: Step | undefined): Path => {
  const path: PropertyKey[] = [];
  for (let at = step; at !== undefined; at = at.parent) path.unshift(at.key);
  return path;
};

type Task =
  | {
      readonly kind: "write";
      readonly value: unknown;
      readonly name: string;
      readonly step: Step;
    }
  | { readonly kind: "leave"; readonly container: object };

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
  medium: "Multipart" | "URL-encoded",
  isLeaf: (value: unknown) => value is A,
  append: (key: string, value: A) => void,
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

  const write = (value: unknown, name: string, step: Step) => {
    if (isLeaf(value)) append(name, value);
    else if (Array.isArray(value)) list(value, name, step);
    else if (typeof value === "object" && value !== null)
      object(value, name, step);
    else
      refuse(
        step,
        medium === "Multipart"
          ? "must be text, a Blob or File, or a form container"
          : "must be text or a form container",
      );
  };

  if (typeof input !== "object" || input === null)
    refuse(undefined, "must be a form object");
  object(input as object, "", undefined);
  while (tasks.length > 0) {
    const task = tasks.pop()!;
    if (task.kind === "leave") active.delete(task.container);
    else write(task.value, task.name, task.step);
  }
}

const isBodyWriteError = (error: unknown): error is BodyWriteError =>
  error instanceof BodyWriteError;

const multipart = new SchemaTransformation.Transformation(
  SchemaTransformation.fromFormData.decode,
  SchemaGetter.transformEffect((input: unknown) =>
    checked(
      () => {
        // A schema can keep an already prepared form, from any implementation.
        if (isFormData(input)) return input;
        const form = new FormData();
        writeTree(input, "Multipart", isPart, (key, value) =>
          form.append(key, value),
        );
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
        writeTree(input, "URL-encoded", isText, (key, value) =>
          params.append(key, value),
        );
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

/** The direct URL-encoded writer, for Effect `UrlParams` with text or redacted text values. */
export const encodeUrlParams = (input: UrlParams.UrlParams) =>
  checkedBody(() => {
    if (typeof input !== "object" || input === null)
      refuseParams([], "must be UrlParams");
    const pairs: unknown = input.params;
    if (!Array.isArray(pairs))
      return refuseParams([], "must contain an array of pairs");
    const length = pairs.length;
    const extra = extraArrayField(pairs, length);
    if (extra !== undefined)
      refuseParams([extra], "cannot encode an extra array field");
    const params = new URLSearchParams();
    for (let index = 0; index < length; index++) {
      const pair: unknown = pairs[index];
      if (!Array.isArray(pair) || pair.length !== 2)
        refuseParams([index], "must be a pair");
      const name: unknown = (pair as unknown[])[0];
      const value: unknown = (pair as unknown[])[1];
      const field = extraArrayField(pair as unknown[], 2);
      if (field !== undefined)
        refuseParams([index, field], "cannot encode an extra array field");
      if (typeof name !== "string")
        return refuseParams([index, 0], "must have a string name");
      const text = Redacted.isRedacted(value) ? Redacted.value(value) : value;
      if (typeof text !== "string") refuseParams([name], "must be a string");
      params.append(name, text as string);
    }
    return HttpBody.text(
      params.toString(),
      "application/x-www-form-urlencoded",
    );
  });
