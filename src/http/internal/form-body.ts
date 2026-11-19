import {
  Effect,
  Redacted,
  Schema,
  SchemaAST,
  SchemaGetter,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import { HttpBody, UrlParams } from "effect/http";

// Effect's AST rebuild retains checks, contexts and the identity of unchanged schema bodies.
// The runtime exposes these operations, although its declarations omit the internal methods.
const { replaceEncoding } = SchemaAST as typeof SchemaAST & {
  replaceEncoding(
    ast: SchemaAST.AST,
    encoding: SchemaAST.Encoding | undefined,
  ): SchemaAST.AST;
};

const validationErrors = new WeakSet<object>();

class InvalidForm extends TypeError {
  constructor(
    readonly path: ReadonlyArray<PropertyKey>,
    message: string,
  ) {
    super(message);
    validationErrors.add(this);
  }

  static is(error: unknown): error is InvalidForm {
    return (
      typeof error === "object" && error !== null && validationErrors.has(error)
    );
  }
}

const issue = (error: InvalidForm): SchemaIssue.Issue => {
  const reason = new SchemaIssue.InvalidValue({ message: error.message });
  return error.path.length === 0
    ? reason
    : new SchemaIssue.Pointer(error.path, reason);
};

const checked = <A, E>(write: () => A, error: (cause: InvalidForm) => E) =>
  Effect.try({ try: write, catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      InvalidForm.is(cause) ? Effect.fail(error(cause)) : Effect.die(cause),
    ),
  );

const isText = (value: unknown): value is string => typeof value === "string";
const blobSize =
  typeof Blob === "undefined"
    ? undefined
    : Object.getOwnPropertyDescriptor(Blob.prototype, "size")?.get;
const isFormValue = (value: unknown): value is string | Blob => {
  if (isText(value)) return true;
  if (typeof value !== "object" || value === null || blobSize === undefined)
    return false;
  try {
    blobSize.call(value);
    return true;
  } catch {
    return false;
  }
};

/** Use Effect's bracket paths and repeated leaf lists, checking each value as it is read. */
const writeTree = <A>(
  input: unknown,
  isLeaf: (value: unknown) => value is A,
  append: (key: string, value: A) => void,
): void => {
  const active = new Set<object>();

  function writeObject(
    value: object,
    name: string,
    path: ReadonlyArray<PropertyKey>,
  ) {
    if (active.has(value)) throw new InvalidForm(path, "Circular form data");
    active.add(value);
    const entries: Array<readonly [string, unknown]> = [];
    for (const key of Reflect.ownKeys(value)) {
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) continue;
      const entry: unknown = Reflect.get(value, key);
      if (entry === undefined) continue;
      if (typeof key === "symbol")
        throw new InvalidForm(
          [...path, key],
          "A form field name must be a string",
        );
      entries.push([key, entry]);
    }
    if (entries.length === 0 && path.length > 0)
      throw new InvalidForm(path, "A form field must write at least one value");
    for (const [key, entry] of entries)
      write(entry, path.length === 0 ? key : `${name}[${key}]`, [...path, key]);
    active.delete(value);
  }

  function write(
    value: unknown,
    name: string,
    path: ReadonlyArray<PropertyKey>,
  ): void {
    if (isLeaf(value)) return append(name, value);
    if (Array.isArray(value)) {
      if (active.has(value)) throw new InvalidForm(path, "Circular form data");
      active.add(value);
      const items: Array<readonly [number, unknown]> = [];
      let leaves = true;
      const length = value.length;
      for (let index = 0; index < length; index++) {
        if (!(index in value)) continue;
        const entry: unknown = value[index];
        leaves &&= isLeaf(entry);
        items.push([index, entry]);
      }
      if (items.length === 0)
        throw new InvalidForm(
          path,
          "A form field must write at least one value",
        );
      for (const [index, entry] of items) {
        if (leaves) append(name, entry as A);
        else write(entry, `${name}[${index}]`, [...path, index]);
      }
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === "string") {
          const index = Number(key);
          if (
            Number.isInteger(index) &&
            index >= 0 &&
            index < length &&
            String(index) === key
          )
            continue;
        }
        if (
          Object.prototype.propertyIsEnumerable.call(value, key) &&
          Reflect.get(value, key) !== undefined
        )
          throw new InvalidForm(
            [...path, key],
            "A form list field must use array positions",
          );
      }
      active.delete(value);
    } else if (typeof value === "object" && value !== null) {
      writeObject(value, name, path);
    } else {
      throw new InvalidForm(
        path,
        "A form value has no supported wire representation",
      );
    }
  }

  if (typeof input !== "object" || input === null)
    throw new InvalidForm([], "A form body must be an object");
  writeObject(input, "", []);
};

const multipart = new SchemaTransformation.Transformation(
  SchemaTransformation.fromFormData.decode,
  SchemaGetter.transformEffect((input: unknown) =>
    checked(() => {
      // An open schema's decoded side can also accept the already prepared wire value.
      if (input instanceof FormData) return input;
      const form = new FormData();
      writeTree(input, isFormValue, (key, value) => form.append(key, value));
      return form;
    }, issue),
  ),
);

const searchParams = new SchemaTransformation.Transformation(
  SchemaTransformation.fromURLSearchParams.decode,
  SchemaGetter.transformEffect((input: unknown) =>
    checked(() => {
      if (input instanceof URLSearchParams) return input;
      const params = new URLSearchParams();
      writeTree(input, isText, (key, value) => params.append(key, value));
      return params;
    }, issue),
  ),
);

const recordLink = Schema.RecordFromUrlParams.ast.encoding?.at(-1);
const urlParamsRecord = new SchemaTransformation.Transformation(
  SchemaGetter.transform(UrlParams.toReadonlyRecord),
  SchemaGetter.transformEffect((input: unknown) =>
    checked(() => {
      const entries: Array<readonly [string, string]> = [];
      writeTree(input, isText, (key, value) => entries.push([key, value]));
      return UrlParams.make(entries);
    }, issue),
  ),
);

/** Install checked versions of the actual Effect form writers, wherever encoding invokes them. */
export const codec = <S extends Schema.Top>(schema: S): S => {
  const cache = new WeakMap<SchemaAST.AST, SchemaAST.AST>();
  const replace = (ast: SchemaAST.AST): SchemaAST.AST => {
    const existing = cache.get(ast);
    if (existing !== undefined) return existing;
    const encoding =
      ast.encoding &&
      (SchemaAST.mapOrSame(ast.encoding, (link) => {
        const target = replace(link.to);
        const transformation =
          link.transformation === SchemaTransformation.fromFormData
            ? multipart
            : link.transformation === SchemaTransformation.fromURLSearchParams
              ? searchParams
              : link.transformation === recordLink?.transformation
                ? urlParamsRecord
                : link.transformation;
        return target === link.to && transformation === link.transformation
          ? link
          : new SchemaAST.Link(target, transformation);
      }) as SchemaAST.Encoding);
    // Suspend.recur composes the rewrite into the thunk without forcing it here.
    const { recur } = ast as SchemaAST.AST & {
      recur?: (map: (child: SchemaAST.AST) => SchemaAST.AST) => SchemaAST.AST;
    };
    const body = recur?.call(ast, replace) ?? ast;
    const result = replaceEncoding(body, encoding);
    cache.set(ast, result);
    return result;
  };
  const ast = replace(schema.ast);
  return ast === schema.ast ? schema : Schema.make<S>(ast);
};

export const encodeFormData = (input: FormData) =>
  checked(
    () => {
      if (!(input instanceof FormData))
        throw new InvalidForm([], "A multipart body must be FormData");
      // A prototype lookalike has no native form state. Leave native invocation errors as defects.
      FormData.prototype.has.call(input, "");
      return HttpBody.formData(input);
    },
    (cause) => new Schema.SchemaError(issue(cause)),
  );

export const encodeUrlParams = (input: UrlParams.UrlParams) =>
  checked(
    () => {
      const params = new URLSearchParams();
      if (typeof input !== "object" || input === null)
        throw new InvalidForm([], "A URL-encoded form must be UrlParams");
      const pairs = input.params;
      if (!Array.isArray(pairs))
        throw new InvalidForm(
          [],
          "A URL-encoded form must contain an array of pairs",
        );
      const length = pairs.length;
      for (let index = 0; index < length; index++) {
        const pair = pairs[index];
        if (!Array.isArray(pair) || pair.length !== 2)
          throw new InvalidForm(
            [index],
            "A URL-encoded form field must be a pair",
          );
        const name: unknown = pair[0];
        const value: unknown = pair[1];
        if (typeof name !== "string")
          throw new InvalidForm(
            [index, 0],
            "A URL-encoded form field name must be a string",
          );
        const text = Redacted.isRedacted(value) ? Redacted.value(value) : value;
        if (typeof text !== "string")
          throw new InvalidForm(
            [name],
            "A URL-encoded form value must be a string",
          );
        params.append(name, text);
      }
      return HttpBody.text(
        params.toString(),
        "application/x-www-form-urlencoded",
      );
    },
    (cause) => new Schema.SchemaError(issue(cause)),
  );
