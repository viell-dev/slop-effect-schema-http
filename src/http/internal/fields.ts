/** A field value, or a computation that stays data until materialization. `undefined` omits the field. */
export type Value<A = string> = A | (() => A | undefined);

/**
 * One declaration. A query entry written in a request's constructor also keeps that text. An edit
 * makes a new entry, so the text falls away with the old one.
 */
export type Field<A = string> = readonly [
  name: string,
  value: Value<A>,
  written?: string,
];

/** Ordered declarations. Entries preserve repetition and their order across names. */
export type Fields<A = string> = ReadonlyArray<Field<A>>;

/** The form two names are compared in. Entries keep their own spelling. */
export type Fold = (name: string) => string;

const exact: Fold = (name) => name;

/** Put values at a name's first position and drop its later entries, or append new entries. */
export const replace = <A>(
  fields: Fields<A>,
  name: string,
  values: ReadonlyArray<Value<A>>,
  fold: Fold = exact,
): Fields<A> => {
  const folded = fold(name);
  const position = fields.findIndex(([key]) => fold(key) === folded);
  const entries = values.map((value): Field<A> => [name, value]);
  if (position < 0) return [...fields, ...entries];
  return fields.flatMap((entry, index): ReadonlyArray<Field<A>> =>
    index === position ? entries : fold(entry[0]) === folded ? [] : [entry],
  );
};

/** Replace a name with one value. */
export const set = <A>(
  fields: Fields<A>,
  name: string,
  value: Value<A>,
  fold: Fold = exact,
): Fields<A> => replace(fields, name, [value], fold);

export const append = <A>(
  fields: Fields<A>,
  name: string,
  value: Value<A>,
): Fields<A> => [...fields, [name, value]];

/** Without a value, remove the whole name. With one, remove matching static entries without evaluating computations. */
export const remove = <A>(
  fields: Fields<A>,
  name: string,
  value?: A,
  fold: Fold = exact,
): Fields<A> =>
  fields.filter(
    ([key, entry]) =>
      fold(key) !== fold(name) || (value !== undefined && entry !== value),
  );

/** Evaluate every surviving computation once, omitting `undefined` results. */
export const resolve = <A extends string | null>(
  fields: Fields<A>,
): Array<readonly [string, A]> => {
  const output: Array<readonly [string, A]> = [];
  for (const [name, value] of fields) {
    const resolved = typeof value === "function" ? value() : value;
    if (resolved !== undefined) output.push([name, resolved]);
  }
  return output;
};
