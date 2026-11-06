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

/** Replace a name at its first position and drop its later entries, or append a new entry. */
export const set = <A>(
  fields: Fields<A>,
  name: string,
  value: Value<A>,
  fold: Fold = exact,
): Fields<A> => {
  const folded = fold(name);
  const position = fields.findIndex(([key]) => fold(key) === folded);
  if (position < 0) return [...fields, [name, value]];
  return fields.flatMap((entry, index): Array<Field<A>> =>
    index === position
      ? [[name, value]]
      : fold(entry[0]) === folded
        ? []
        : [entry],
  );
};

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
