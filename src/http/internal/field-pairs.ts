export type Pair = readonly [string, unknown];

const invalidPair = () =>
  new TypeError("A field pair must have a string name and a value position");

const namedPair = (name: unknown, value: unknown): Pair => {
  if (typeof name !== "string") throw invalidPair();
  return [name, value];
};

const readPair = (pair: ReadonlyArray<unknown>): Pair => {
  if (pair.length !== 2 || !(1 in pair)) throw invalidPair();
  return namedPair(pair[0], pair[1]);
};

/** Read both levels positionally, even if the arrays have their own iterator or no prototype. */
export const fromArray = (
  input: ReadonlyArray<unknown>,
): ReadonlyArray<Pair> => {
  const pairs: Pair[] = [];
  const length = input.length;
  for (let index = 0; index < length; index++) {
    const pair = input[index];
    if (!Array.isArray(pair)) throw invalidPair();
    pairs.push(readPair(pair));
  }
  return pairs;
};

/** Non-array entries from a generic iterable retain its original destructuring behavior. */
export const iterableEntry = (pair: unknown): Pair => {
  if (Array.isArray(pair)) return readPair(pair);
  const [name, value] = pair as Iterable<unknown>;
  return namedPair(name, value);
};

/** Non-array collections still use the iterable protocol. */
export const fromIterable = (input: object): ReadonlyArray<Pair> =>
  Array.from(input as Iterable<unknown>).map(iterableEntry);
