import {
  Data,
  Effect,
  type Option,
  Result,
  Schema,
  type SchemaAST,
  SchemaIssue,
} from "effect";
import { definesField, hasDefinedFields } from "./excess.js";
import { isPlainData } from "./plain.js";
import { extraArrayField } from "./writer-error.js";

/** A fieldless ambiguity, or an enclosing oneOf left with multiple complete readers. */
export class FieldlessOneOf extends Data.TaggedError("FieldlessOneOf")<{
  readonly path: ReadonlyArray<PropertyKey>;
  readonly ast: SchemaAST.Union;
  readonly matches: ReadonlyArray<SchemaAST.AST>;
  /** The enclosing union failed as a whole. Another alternative can fit on the other side. */
  readonly insideUnion?: true;
  /**
   * It stands only because another reading of the same value failed. A pass that refuses keys
   * Effect strips cannot settle that: the reading may have failed on such a key alone.
   */
  readonly afterAlternative?: true;
}> {}

/** Another reading of the same value failed, so the ambiguity stands for this pass. */
export const afterAlternative = (failure: FieldlessOneOf): FieldlessOneOf =>
  failure.afterAlternative
    ? failure
    : new FieldlessOneOf({ ...failure, afterAlternative: true });

/** The encoded read only succeeded by using a native Option wrapper as a wire value. */
export class OptionWrapperRead extends Data.TaggedError("OptionWrapperRead")<{
  readonly failure: Schema.SchemaError;
  /** The wrappers that read took as wire values. */
  readonly wrappers: ReadonlySet<Option.Option<unknown>>;
  /** Where that read was, below the value of the reading this comes from. */
  readonly at: ReadonlyArray<PropertyKey>;
}> {}

export type ReadFailure =
  Schema.SchemaError | FieldlessOneOf | OptionWrapperRead;

const isFieldless = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  isPlainData(value) &&
  !hasDefinedFields(value) &&
  (!Array.isArray(value) || extraArrayField(value, value.length) === undefined);

/**
 * Whether a read of `value` can find an ambiguity in it: whether it is, or holds in an own data field
 * at any depth, a fieldless plain object or list. {@link readFailure} names only such a value
 * ambiguous, reached as this reaches it, through own data fields of any object, plain or not.
 *
 * @remarks
 * A typed array or other `ArrayBuffer` view counts as holding one without being looked into: its
 * indexes hold only numbers, but listing them would cost more than the read this can save.
 */
export const mayHoldFieldless = (value: unknown): boolean => {
  const seen = new Set<object>();
  // The values still to look at, in place of recursion, so that a deep value takes no stack.
  const pending: Array<unknown> = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node !== "object" || node === null || seen.has(node)) continue;
    seen.add(node);
    if (ArrayBuffer.isView(node)) return true;
    // One pass over its keys finds what the node holds and whether it defines a field. Only a node
    // that defines none can be fieldless.
    let defines = false;
    for (const key of Reflect.ownKeys(node)) {
      const field = Object.getOwnPropertyDescriptor(node, key);
      // An accessor is not run, as `ownValueAt` does not run it.
      if (field === undefined || !("value" in field)) continue;
      const held: unknown = field.value;
      if (typeof held === "object" && held !== null) pending.push(held);
      defines ||= definesField(node, key);
    }
    if (!defines && isFieldless(node)) return true;
  }
  return false;
};

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
  fieldlessAt: (path: ReadonlyArray<PropertyKey>) => boolean,
  path: ReadonlyArray<PropertyKey>,
): FieldlessOneOf | "invalid" | undefined => {
  switch (issue._tag) {
    case "Pointer":
      return locate(issue.issue, fieldlessAt, [...path, ...issue.path]);
    case "Encoding":
    case "Filter":
      return locate(issue.issue, fieldlessAt, path);
    case "Composite": {
      let ambiguity: FieldlessOneOf | undefined;
      for (const member of issue.issues) {
        const found = locate(member, fieldlessAt, path);
        if (found === "invalid") return found;
        ambiguity ??= found;
      }
      return ambiguity;
    }
    case "AnyOf": {
      for (const member of issue.issues) {
        const found = locate(member, fieldlessAt, path);
        if (found !== undefined && found !== "invalid")
          return issue.ast.types.length === 1 || found.insideUnion
            ? found
            : new FieldlessOneOf({ ...found, insideUnion: true });
      }
      return "invalid";
    }
    case "UnexpectedKey":
      return undefined;
    case "OneOf":
      if (
        fieldlessAt(path) &&
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

/** A strict pass may copy an opaque value into a plain object. The copy is not a witness. */
export const hasPlainWitness = (
  input: unknown,
  path: ReadonlyArray<PropertyKey>,
) => {
  const value = ownValueAt(input, path);
  return typeof value === "object" && value !== null && isPlainData(value);
};

export const readFailure = (
  failure: Schema.SchemaError,
  input: unknown,
  normalised: () => unknown,
  witness?: (path: ReadonlyArray<PropertyKey>) => boolean,
): ReadFailure => {
  const found = locate(
    failure.issue,
    (path) =>
      isFieldless(ownValueAt(input, path)) &&
      (witness?.(path) ?? true) &&
      isFieldless(ownValueAt(normalised(), path)),
    [],
  );
  return found === undefined || found === "invalid" ? failure : found;
};

/** Only an ordinary schema failure permits general fallback. */
export const recoverRead = <A, B, E, R, R2>(
  effect: Effect.Effect<A, ReadFailure, R>,
  recover: (error: Schema.SchemaError) => Effect.Effect<B, E, R2>,
): Effect.Effect<A | B, E | FieldlessOneOf | OptionWrapperRead, R | R2> =>
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
export const publicAmbiguity = (
  failure: FieldlessOneOf,
  options?: SchemaAST.ParseOptions,
): Schema.SchemaError => {
  const issue = new SchemaIssue.OneOf(failure.ast, failure.matches, undefined, {
    ...options,
    reportInput: false,
  });
  return new Schema.SchemaError(
    failure.path.length === 0
      ? issue
      : new SchemaIssue.Pointer(failure.path, issue),
  );
};

export const publicRead = <A, R>(
  read: Effect.Effect<A, ReadFailure, R>,
  options?: SchemaAST.ParseOptions,
): Effect.Effect<A, Schema.SchemaError, R> =>
  Effect.mapError(read, (error) =>
    error._tag === "FieldlessOneOf"
      ? publicAmbiguity(error, options)
      : error._tag === "OptionWrapperRead"
        ? error.failure
        : error,
  );
