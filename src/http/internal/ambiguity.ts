import { Data, Effect, Schema, type SchemaAST, SchemaIssue } from "effect";
import { hasDefinedFields } from "./excess.js";
import { isPlainData } from "./plain.js";
import { extraArrayField } from "./writer-error.js";

export class FieldlessOneOf extends Data.TaggedError("FieldlessOneOf")<{
  readonly path: ReadonlyArray<PropertyKey>;
  readonly ast: SchemaAST.Union;
  readonly matches: ReadonlyArray<SchemaAST.AST>;
  /** The ambiguity was one of several failed alternatives of an enclosing union. */
  readonly besideAlternative?: true;
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
 * independently invalid sibling. Let fieldwise recovery decide where the whole read cannot.
 */
const locate = (
  issue: SchemaIssue.Issue,
  input: unknown,
  path: ReadonlyArray<PropertyKey>,
): FieldlessOneOf | "invalid" | undefined => {
  switch (issue._tag) {
    case "Pointer":
      return locate(issue.issue, input, [...path, ...issue.path]);
    case "Encoding":
      return locate(issue.issue, input, path);
    case "Composite": {
      let ambiguity: FieldlessOneOf | undefined;
      for (const member of issue.issues) {
        const found = locate(member, input, path);
        if (found === "invalid") return found;
        ambiguity ??= found;
      }
      return ambiguity;
    }
    case "AnyOf": {
      for (const member of issue.issues) {
        const found = locate(member, input, path);
        if (found !== undefined && found !== "invalid")
          return issue.issues.length === 1 || found.besideAlternative
            ? found
            : new FieldlessOneOf({ ...found, besideAlternative: true });
      }
      return "invalid";
    }
    case "UnexpectedKey":
      return undefined;
    case "OneOf":
      if (
        isFieldless(ownValueAt(input, path)) &&
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

export const readFailure = (
  failure: Schema.SchemaError,
  input: unknown,
): ReadFailure => {
  const found = locate(failure.issue, input, []);
  return found === undefined || found === "invalid" ? failure : found;
};

/** Ambiguity is terminal. Only an ordinary schema failure permits a different reading. */
export const recoverRead = <A, B, E, R, R2>(
  effect: Effect.Effect<A, ReadFailure, R>,
  recover: (error: Schema.SchemaError) => Effect.Effect<B, E, R2>,
): Effect.Effect<A | B, E | FieldlessOneOf, R | R2> =>
  Effect.catchTag(effect, "SchemaError", recover);

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
