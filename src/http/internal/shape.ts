import { Effect, Schema, SchemaAST } from "effect";
import * as Excess from "./excess.js";
import type { Fold } from "./fields.js";

/** What one schema says about its field group. Names are wire names, in their compared form. */
export interface Shape {
  /** The names the schema states. */
  readonly names: ReadonlySet<string>;
  /** Whether it allows names it does not state, as a record or a list of pairs does. */
  readonly open: boolean;
  /** The names it always writes, so a raw edit of one could never reach the client. */
  readonly required: ReadonlySet<string>;
  /** Whether it holds a union that can lose a field, which a stacked schema may take. */
  readonly chooses: boolean;
}

/** What the schemas stacked on a group have told each other. */
export interface Taken {
  /** The fields of the caller's input a schema took. Only this says a field is not lost. */
  readonly fields: ReadonlySet<PropertyKey>;
  /** The compared names schemas with no union allow. Each settles a raw value under its names. */
  readonly settled: ReadonlySet<string>;
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

/**
 * Whether a field whose encoded side is optional is written all the same, as a decoding default is.
 * The decoded side has to hold a value, and the step that makes the encoded side optional has to
 * hand that value on as it is. A step that decides for itself may write nothing, as
 * `Schema.OptionFromOptionalKey` does for `None` and the `omit` strategy of a default always does.
 */
const writesOptional = (type: SchemaAST.AST): boolean => {
  const decoded = SchemaAST.toType(type);
  const step = type.encoding?.find(({ to }) => SchemaAST.isOptional(to));
  return (
    !SchemaAST.isOptional(decoded) &&
    !holdsUndefined(decoded) &&
    step?.transformation._tag === "Transformation" &&
    step.transformation.encode._tag === "Passthrough"
  );
};

const readObjects = (ast: SchemaAST.Objects): Reading => {
  const stated = ast.propertySignatures.map(
    ({ name, type }) =>
      [String(name), SchemaAST.toEncoded(type), type] as const,
  );
  return {
    fields: new Map(stated.map(([name, encoded]) => [name, [encoded]])),
    rest: ast.indexSignatures.map(({ type }) => SchemaAST.toEncoded(type)),
    open: ast.indexSignatures.length > 0,
    required: new Set(
      stated
        .filter(
          ([, encoded, type]) =>
            (!SchemaAST.isOptional(encoded) && !holdsUndefined(encoded)) ||
            writesOptional(type),
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

/** Read a schema's encoded side. Where names cannot be read, the schema allows any name. */
const read = (ast: SchemaAST.AST): Reading => {
  const end = Excess.encodedEnd(ast);
  return end._tag === "Objects"
    ? readObjects(end)
    : end._tag === "Union"
      ? readUnion(end.types.map(read))
      : { fields: new Map(), rest: [], open: true, required: new Set() };
};

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

/** The names a schema's output holds a value under, as the schema spells them. */
const writtenNames = (output: object): ReadonlyArray<string> =>
  (Symbol.iterator in output
    ? Array.from(output as Iterable<readonly [string, unknown]>)
    : Object.entries(output)
  )
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name);

/**
 * The names a schema's output writes, in their compared form. A name with no value writes nothing,
 * so a default stays, while an empty list is the caller saying there are no entries.
 */
export const written = (output: object, fold: Fold): ReadonlySet<string> =>
  new Set(writtenNames(output).map(fold));

const noNames: ReadonlySet<PropertyKey> = new Set();

/**
 * The names a raw value does not concern a union under, in their compared form: what another schema
 * took from the caller, and what a schema with no union settles itself. A schema with no choice
 * settles its own defaults, so nothing is left to it by this.
 */
export const others = (
  shape: Shape,
  taken: Taken | undefined,
  fold: Fold,
): ReadonlySet<PropertyKey> =>
  !shape.chooses || taken === undefined
    ? noNames
    : new Set([
        ...Array.from(taken.fields, (name) =>
          typeof name === "string" ? fold(name) : name,
        ),
        ...taken.settled,
      ]);

/** The record once a schema has added what it took. */
export const taking = (
  taken: Taken | undefined,
  own: ReadonlySet<PropertyKey>,
): Taken => ({
  fields: new Set([...(taken?.fields ?? []), ...own]),
  settled: taken?.settled ?? new Set(),
});

/**
 * What went into `settle` and is gone from what came out, in the spelling it went in with. A schema
 * can write less than it was given, and that must not pass as a group that was built.
 */
export const lost = (
  output: object,
  defaults: ReadonlyArray<readonly [string, unknown]>,
  settled: object,
  fold: Fold,
): ReadonlyArray<string> => {
  const kept = written(settled, fold);
  return [...writtenNames(output), ...defaults.map(([name]) => name)].filter(
    (name) => !kept.has(fold(name)),
  );
};

/**
 * Read what a schema says about its group, and build what it sends.
 *
 * @remarks
 * `settle` adds defaults to what the schema wrote and takes the whole group through the schema in
 * both directions. A decoder may accept more spellings than its encoder writes, so a default that
 * decodes is not yet what the schema sends.
 *
 * Effect strips what a union member does not state, so the first member that fits part of the group
 * would win over a later one that holds all of it. `settle` therefore looks for such a member first.
 * Without one it takes the looser match, and {@link lost} tells the caller what that left out.
 */
export const bind = <S extends Schema.Constraint>(contract: S, fold: Fold) => {
  const reading = read(contract.ast);
  const spelling = new Map(
    Array.from(reading.fields.keys(), (name) => [fold(name), name] as const),
  );
  const decode = Schema.decodeUnknownEffect(contract);
  const encode = Schema.encodeEffect(contract);
  const chooses = Excess.choosesMember(contract.ast);
  const shape: Shape = {
    names: new Set(spelling.keys()),
    open: reading.open,
    required: new Set(Array.from(reading.required, fold)),
    chooses,
  };
  // A group transformation or declaration can change names or construct in its own way.
  const constructorNames =
    contract.ast._tag === "Objects" && contract.ast.encoding === undefined
      ? contract.ast.propertySignatures.flatMap(({ name, type }) =>
          typeof name === "string" &&
          type.context?.constructorDefault !== undefined
            ? [name]
            : [],
        )
      : [];
  /** Only stable absent/data properties prove the caller did not supply this field. */
  const omitted = (input: object, name: string): boolean => {
    const property = Object.getOwnPropertyDescriptor(input, name);
    return property === undefined
      ? !(name in input)
      : "value" in property && property.value === undefined;
  };
  /** Snapshot caller omission before preparation can run a default or encoder. */
  const candidates = (
    input: unknown,
    edits: ReadonlySet<string> | undefined,
  ): ReadonlyArray<string> =>
    edits !== undefined && typeof input === "object" && input !== null
      ? constructorNames.filter(
          (name) => edits.has(fold(name)) && omitted(input, name),
        )
      : [];
  /** The successful first constructor actually supplied these edited, encoded fields. */
  const filled = (
    names: ReadonlyArray<string>,
    constructed: unknown,
    output: unknown,
  ): ReadonlyArray<string> => {
    if (
      typeof constructed !== "object" ||
      constructed === null ||
      typeof output !== "object" ||
      output === null
    )
      return [];
    return names
      .filter((name) => {
        const made = Object.getOwnPropertyDescriptor(constructed, name);
        const encoded = Object.getOwnPropertyDescriptor(output, name);
        return (
          made !== undefined &&
          "value" in made &&
          made.value !== undefined &&
          encoded?.enumerable === true &&
          "value" in encoded &&
          encoded.value !== undefined
        );
      })
      .map(fold);
  };
  /**
   * The caller's fields this schema took: what it wrote, and any it states and the caller gave,
   * which may be written under another name or not at all. What it would lose is not among them.
   */
  const taken = (
    input: unknown,
    output: object,
    losing: ReadonlyArray<Excess.Path>,
  ): ReadonlySet<PropertyKey> =>
    new Set(
      [
        ...writtenNames(output),
        ...Excess.statedFields(contract.ast, input),
      ].filter((name) => !losing.some(([key]) => key === name)),
    );
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
    const group =
      Symbol.iterator in output
        ? [...(output as unknown as Iterable<unknown>), ...pairs]
        : { ...output, ...record };
    const through = (options?: SchemaAST.ParseOptions) =>
      Effect.flatMap(
        decode(group, options),
        (decoded) =>
          encode(decoded, options) as Effect.Effect<W, Schema.SchemaError>,
      );
    return Effect.catch(through({ onExcessProperty: "error" }), () =>
      through(),
    );
  };
  return { shape, settle, taken, candidates, filled };
};
