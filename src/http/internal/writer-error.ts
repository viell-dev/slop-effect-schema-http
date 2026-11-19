import { Effect, SchemaIssue } from "effect";
import { HttpBody } from "effect/http";

const refusals = new WeakSet<object>();

/**
 * A writer's own refusal, as opposed to an exception thrown by caller code.
 *
 * @remarks
 * Writers recognize their refusals by this brand alone, so a caller's own `TypeError` or an object
 * built on this prototype is never mistaken for one.
 */
export class WriterError extends TypeError {
  constructor(message: string) {
    super(message);
    refusals.add(this);
  }
}

export const isWriterError = (error: unknown): error is WriterError =>
  typeof error === "object" && error !== null && refusals.has(error);

/** Run a writer, failing with its refusal and letting any other exception die. */
export const checked = <A, C extends WriterError, E>(
  write: () => A,
  isRefusal: (cause: WriterError) => cause is C,
  failure: (cause: C) => E,
) =>
  Effect.try({ try: write, catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      isWriterError(cause) && isRefusal(cause)
        ? Effect.fail(failure(cause))
        : Effect.die(cause),
    ),
  );

export type Path = ReadonlyArray<PropertyKey>;

/** A path in the `$["field"][0]` form the writers' messages use. */
export const textPath = (path: Path): string =>
  "$" +
  path
    .map(
      (key) =>
        "[" +
        (typeof key === "symbol" ? String(key) : JSON.stringify(key)) +
        "]",
    )
    .join("");

/** A body writer's refusal of the value at a path. */
export class BodyWriteError extends WriterError {
  constructor(
    readonly medium: string,
    readonly path: Path,
    readonly explanation: string,
  ) {
    super(`${medium} body at ${textPath(path)} ${explanation}`);
  }
}

const isBodyWriteError = (error: WriterError): error is BodyWriteError =>
  error instanceof BodyWriteError;

/** Report a refusal as Effect's body error, with the path as a schema issue for other media. */
export const bodyError = (cause: BodyWriteError): HttpBody.HttpBodyError => {
  const problem = new SchemaIssue.InvalidValue({ message: cause.explanation });
  // Effect's HttpBodyError has a JSON reason and a schema-issue reason for other media.
  const reason: HttpBody.ErrorReason =
    cause.medium === "JSON"
      ? { _tag: "JsonError" }
      : {
          _tag: "SchemaError",
          issue:
            cause.path.length > 0
              ? new SchemaIssue.Pointer(cause.path, problem)
              : problem,
        };
  const error = new HttpBody.HttpBodyError({ reason, cause });
  error.message = cause.message;
  return error;
};

export const checkedBody = <A>(write: () => A) =>
  checked(write, isBodyWriteError, bodyError);

const isPosition = (key: string, length: number): boolean => {
  const position = Number(key);
  return (
    Number.isInteger(position) &&
    position >= 0 &&
    position < length &&
    String(position) === key
  );
};

/** An own field that would supply a value: enumerable, and an accessor or a defined value. */
const supplies = (values: object, key: PropertyKey): boolean => {
  const field = Object.getOwnPropertyDescriptor(values, key);
  // Do not run accessors for fields outside the positions a writer reads.
  return (
    field?.enumerable === true &&
    (!("value" in field) || field.value !== undefined)
  );
};

/**
 * The first own field of an array outside its positions, which a positional writer would drop.
 *
 * @remarks
 * `Object.keys` lists integer keys first, in ascending order. So when it lists exactly `length`
 * names and the last is the final position, every name is a position and only symbols remain to
 * check. That keeps the common case to one native call.
 */
export function extraArrayField(
  values: ReadonlyArray<unknown>,
  length: number,
): PropertyKey | undefined {
  const names = Object.keys(values);
  const onlyPositions =
    names.length === length &&
    (length === 0 || names[length - 1] === String(length - 1));
  if (!onlyPositions)
    for (const name of names)
      if (!isPosition(name, length) && supplies(values, name)) return name;
  for (const key of Object.getOwnPropertySymbols(values))
    if (supplies(values, key)) return key;
  return undefined;
}
