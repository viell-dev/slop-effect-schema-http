import { Effect, Schema, SchemaAST } from "effect";
import type { Fold } from "./fields.js";

/** What one schema says about its field group. Names are wire names, in their compared form. */
export interface Shape {
  /** The names the schema states. */
  readonly names: ReadonlySet<string>;
  /** Whether it allows names it does not state, as a record or a list of pairs does. */
  readonly open: boolean;
  /** The names it always writes, so a raw edit of one could never reach the client. */
  readonly required: ReadonlySet<string>;
}

/** What a schema's encoded side states, in the schema's own spelling. */
interface Reading {
  /** Each stated name, with its encoded type in every union member that states it. */
  readonly fields: ReadonlyMap<string, ReadonlyArray<SchemaAST.AST>>;
  /** The encoded types of names a record or a rest allows. */
  readonly rest: ReadonlyArray<SchemaAST.AST>;
  readonly open: boolean;
  readonly required: ReadonlySet<string>;
}

const holdsUndefined = (ast: SchemaAST.AST): boolean =>
  ast._tag === "Undefined" ||
  ast._tag === "Void" ||
  (ast._tag === "Union" && ast.types.some(holdsUndefined));

const readObjects = (ast: SchemaAST.Objects): Reading => {
  const stated = ast.propertySignatures.map(
    ({ name, type }) => [String(name), type] as const,
  );
  return {
    fields: new Map(stated.map(([name, type]) => [name, [type]])),
    rest: ast.indexSignatures.map(({ type }) => type),
    open: ast.indexSignatures.length > 0,
    required: new Set(
      stated
        .filter(
          ([, type]) => !SchemaAST.isOptional(type) && !holdsUndefined(type),
        )
        .map(([name]) => name),
    ),
  };
};

/** A union allows what any member allows and always writes what every member writes. */
const readUnion = (members: ReadonlyArray<Reading>): Reading => {
  const fields = new Map<string, ReadonlyArray<SchemaAST.AST>>();
  for (const member of members)
    for (const [name, types] of member.fields)
      fields.set(name, [...(fields.get(name) ?? []), ...types]);
  const [first, ...others] = members;
  return {
    fields,
    rest: members.flatMap(({ rest }) => rest),
    open: members.some(({ open }) => open),
    required: new Set(
      Array.from(first?.required ?? []).filter((name) =>
        others.every(({ required }) => required.has(name)),
      ),
    ),
  };
};

/** Read a schema's encoded AST. Where names cannot be read, the schema allows any name. */
const read = (ast: SchemaAST.AST): Reading =>
  ast._tag === "Objects"
    ? readObjects(ast)
    : ast._tag === "Union"
      ? readUnion(ast.types.map(read))
      : { fields: new Map(), rest: [], open: true, required: new Set() };

const takesList = (ast: SchemaAST.AST): boolean =>
  ast._tag === "Arrays" || (ast._tag === "Union" && ast.types.some(takesList));

/** The single values a field's encoded type takes, looking inside unions and lists. */
const scalars = (ast: SchemaAST.AST): ReadonlyArray<SchemaAST.AST> =>
  ast._tag === "Union"
    ? ast.types.flatMap(scalars)
    : ast._tag === "Arrays"
      ? [...ast.elements, ...ast.rest].flatMap(scalars)
      : [ast];

type TextReader = (text: string) => unknown;

const readNumber: TextReader = (text) => {
  if (text === "NaN") return Number.NaN;
  const value = Number(text);
  return text.trim() === "" || Number.isNaN(value) ? text : value;
};

const readBoolean: TextReader = (text) =>
  text === "true" ? true : text === "false" ? false : text;

const readBigInt: TextReader = (text) =>
  /^-?\d+$/.test(text) ? BigInt(text) : text;

/**
 * Text reads as `Schema.DateFromString` reads it. A declaration need not refuse an invalid `Date`
 * as `Schema.Date` does, so text with no date in it stays text for the schema to refuse.
 */
const readDate = (ast: SchemaAST.Declaration): TextReader => {
  const takesDate = Schema.is(Schema.make<Schema.Top>(ast));
  return (text) => {
    const date = new Date(text);
    return !Number.isNaN(date.getTime()) && takesDate(date) ? date : text;
  };
};

const readerFor = (ast: SchemaAST.AST): ReadonlyArray<TextReader> => {
  switch (ast._tag) {
    case "Declaration":
      return [readDate(ast)];
    case "Number":
      return [readNumber];
    case "Boolean":
      return [readBoolean];
    case "BigInt":
      return [readBigInt];
    case "Literal":
      return typeof ast.literal === "number"
        ? [readNumber]
        : typeof ast.literal === "boolean"
          ? [readBoolean]
          : typeof ast.literal === "bigint"
            ? [readBigInt]
            : [];
    case "Enum":
      return ast.enums.some(([, value]) => typeof value === "number")
        ? [readNumber]
        : [];
    default:
      return [];
  }
};

/**
 * Read wire text as the value a field encodes to, the reverse of how the library writes it. A field
 * that can hold text takes it as it is, and text that reads as nothing else stays text for the
 * schema to refuse.
 */
const readText = (
  types: ReadonlyArray<SchemaAST.AST>,
  text: string,
): unknown => {
  const forms = types.flatMap(scalars);
  if (forms.some(({ _tag }) => _tag === "String")) return text;
  for (const reader of forms.flatMap(readerFor)) {
    const value = reader(text);
    if (typeof value !== "string") return value;
  }
  return text;
};

/** Whether a shape allows a name, given in its compared form. */
export const allows = (shape: Shape, name: string): boolean =>
  shape.open || shape.names.has(name);

/** Declared names no bound schema allows. With no schema there is no shape to meet. */
export const outside = (
  names: ReadonlyArray<string>,
  shapes: ReadonlyArray<Shape>,
  fold: Fold,
): ReadonlyArray<string> =>
  shapes.length === 0
    ? []
    : names.filter(
        (name) => !shapes.some((shape) => allows(shape, fold(name))),
      );

/** The edited names some bound schema always writes. */
export const required = (
  names: ReadonlyArray<string>,
  shapes: ReadonlyArray<Shape>,
  fold: Fold,
): ReadonlyArray<string> =>
  names.filter((name) =>
    shapes.some((shape) => shape.required.has(fold(name))),
  );

/**
 * The names a schema's output writes, in their compared form. A name with no value writes nothing,
 * so a default stays, while an empty list is the caller saying there are no entries.
 */
export const written = (output: object, fold: Fold): ReadonlySet<string> =>
  new Set(
    (Symbol.iterator in output
      ? Array.from(output as Iterable<readonly [string, unknown]>)
      : Object.entries(output)
    )
      .filter(([, value]) => value !== undefined)
      .map(([name]) => fold(name)),
  );

/**
 * Read what a schema says about its group, and build what it sends.
 *
 * @remarks
 * `settle` adds defaults to what the schema wrote and takes the whole group through the schema in
 * both directions. A decoder may accept more spellings than its encoder writes, so a default that
 * decodes is not yet what the schema sends.
 */
export const bind = <S extends Schema.Constraint>(contract: S, fold: Fold) => {
  const reading = read(SchemaAST.toEncoded(contract.ast));
  const spelling = new Map(
    Array.from(reading.fields.keys(), (name) => [fold(name), name] as const),
  );
  const decode = Schema.decodeUnknownEffect(contract);
  const encode = Schema.encodeEffect(contract);
  const shape: Shape = {
    names: new Set(spelling.keys()),
    open: reading.open,
    required: new Set(Array.from(reading.required, fold)),
  };
  const settle = <W extends object, A>(
    output: W,
    defaults: ReadonlyArray<readonly [string, A]>,
  ): Effect.Effect<
    W,
    Schema.SchemaError,
    S["DecodingServices"] | S["EncodingServices"]
  > => {
    if (defaults.length === 0) return Effect.succeed(output);
    const values = new Map<string, Array<unknown>>();
    const pairs = defaults.map(([name, value]) => {
      const spelled = spelling.get(fold(name)) ?? name;
      const types = reading.fields.get(spelled) ?? reading.rest;
      const entry = typeof value === "string" ? readText(types, value) : value;
      values.set(spelled, [...(values.get(spelled) ?? []), entry]);
      return [spelled, entry] as const;
    });
    const record = Object.fromEntries(
      Array.from(values, ([name, entries]) => [
        name,
        entries.length > 1 ||
        (reading.fields.get(name) ?? reading.rest).some(takesList)
          ? entries
          : entries[0],
      ]),
    );
    return Effect.flatMap(
      decode(
        Symbol.iterator in output
          ? [...(output as unknown as Iterable<unknown>), ...pairs]
          : { ...output, ...record },
      ),
      (decoded) => encode(decoded) as Effect.Effect<W, Schema.SchemaError>,
    );
  };
  return { shape, settle };
};
