import {
  Data,
  Effect,
  Result,
  Schema,
  type SchemaAST,
  SchemaIssue,
} from "effect";
import { hasDefinedFields } from "./excess.js";
import { isPlainData } from "./plain.js";
import { extraArrayField } from "./writer-error.js";

export class FieldlessOneOf extends Data.TaggedError("FieldlessOneOf")<{
  readonly path: ReadonlyArray<PropertyKey>;
  readonly ast: SchemaAST.Union;
  readonly matches: ReadonlyArray<SchemaAST.AST>;
  /** The enclosing union failed as a whole. Another alternative can fit on the other side. */
  readonly insideAnyOf?: true;
}> {}

export type ReadFailure = Schema.SchemaError | FieldlessOneOf;

const isFieldless = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  isPlainData(value) &&
  !hasDefinedFields(value) &&
  (!Array.isArray(value) || extraArrayField(value, value.length) === undefined);

const ownValueAt = (
  input: unknown,
  path: ReadonlyArray<PropertyKey>,
): unknown => {
  let value = input;
  for (const key of path) {
    if (typeof value !== "object" || value === null) return undefined;
    value = Object.getOwnPropertyDescriptor(value, key)?.value as unknown;
  }
  return value;
};

/**
 * Extract the ambiguity while the read still knows its input. A union that failed can wrap the
 * ambiguity of one of its alternatives in AnyOf. A diagnostic read can also find it after an
 * independently invalid sibling. A result of `undefined` means only excess keys were found.
 * `"invalid"` means another issue prevents classifying this read as an ambiguity.
 */
const locate = (
  issue: SchemaIssue.Issue,
  input: unknown,
  caller: unknown,
  normalised: () => unknown,
  path: ReadonlyArray<PropertyKey>,
): FieldlessOneOf | "invalid" | undefined => {
  switch (issue._tag) {
    case "Pointer":
      return locate(issue.issue, input, caller, normalised, [
        ...path,
        ...issue.path,
      ]);
    case "Encoding":
    case "Filter":
      return locate(issue.issue, input, caller, normalised, path);
    case "Composite": {
      let ambiguity: FieldlessOneOf | undefined;
      for (const member of issue.issues) {
        const found = locate(member, input, caller, normalised, path);
        if (found === "invalid") return found;
        ambiguity ??= found;
      }
      return ambiguity;
    }
    case "AnyOf": {
      for (const member of issue.issues) {
        const found = locate(member, input, caller, normalised, path);
        if (found !== undefined && found !== "invalid")
          return issue.ast.types.length === 1 ||
            issue.ast.options?.mode === "oneOf" ||
            found.insideAnyOf
            ? found
            : new FieldlessOneOf({ ...found, insideAnyOf: true });
      }
      return "invalid";
    }
    case "UnexpectedKey":
      return undefined;
    case "OneOf":
      if (
        isFieldless(ownValueAt(input, path)) &&
        !hasNamedArrayContent(ownValueAt(caller, path)) &&
        isFieldless(ownValueAt(normalised(), path)) &&
        (issue.input === undefined || isFieldless(issue.input))
      )
        return new FieldlessOneOf({
          path,
          ast: issue.ast,
          matches: issue.successes,
        });
      return "invalid";
    default:
      return "invalid";
  }
};

const hasNamedArrayContent = (value: unknown): boolean =>
  Array.isArray(value) && extraArrayField(value, value.length) !== undefined;

export const readFailure = (
  failure: Schema.SchemaError,
  input: unknown,
  caller: unknown,
  normalised: () => unknown,
): ReadFailure => {
  const found = locate(failure.issue, input, caller, normalised, []);
  return found === undefined || found === "invalid" ? failure : found;
};

/** Only an ordinary schema failure permits general fallback. */
export const recoverRead = <A, B, E, R, R2>(
  effect: Effect.Effect<A, ReadFailure, R>,
  recover: (error: Schema.SchemaError) => Effect.Effect<B, E, R2>,
): Effect.Effect<A | B, E | FieldlessOneOf, R | R2> =>
  Effect.catchTag(effect, "SchemaError", recover);

/** Capture ordinary read failures. An ambiguity stays in the error channel. */
export const attemptRead = <A, R>(effect: Effect.Effect<A, ReadFailure, R>) =>
  recoverRead(Effect.map(effect, Result.succeed), (failure) =>
    Effect.succeed(Result.fail(failure)),
  );

/** Handle a reading's success and ordinary failure without handling ambiguity. */
export const matchRead = <A, B, C, E, E2, R, R2, R3>(
  effect: Effect.Effect<A, ReadFailure, R>,
  handlers: {
    readonly onSuccess: (value: A) => Effect.Effect<B, E, R2>;
    readonly onFailure: (error: Schema.SchemaError) => Effect.Effect<C, E2, R3>;
  },
) =>
  Effect.flatMap(
    attemptRead(effect),
    (result): Effect.Effect<B | C, E | E2, R2 | R3> =>
      Result.match(result, handlers),
  );

/** The public issue carries only the ambiguous path and match information, without input. */
export const publicRead = <A, R>(
  read: Effect.Effect<A, ReadFailure, R>,
  options?: SchemaAST.ParseOptions,
): Effect.Effect<A, Schema.SchemaError, R> =>
  Effect.mapError(read, (error) => {
    if (error._tag === "SchemaError") return error;
    const issue = new SchemaIssue.OneOf(error.ast, error.matches, undefined, {
      ...options,
      reportInput: false,
    });
    return new Schema.SchemaError(
      error.path.length === 0
        ? issue
        : new SchemaIssue.Pointer(error.path, issue),
    );
  });
