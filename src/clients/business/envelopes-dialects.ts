import {
  Effect,
  Option,
  Schema,
  SchemaGetter,
  SchemaIssue,
  SchemaTransformation,
} from "effect";

/*
 * Consumer-side schemas for the JSON dialects of the business API's `/v1/` envelopes. Each one is a
 * plain Effect schema over text or parsed JSON; the library itself knows nothing about them. Every
 * transform here either round-trips (its tests prove it) or refuses to encode with a reason.
 */

const issue = (message: string, input?: unknown) =>
  new SchemaIssue.InvalidValue({ message }, input);

const fail = (message: string, input?: unknown) =>
  Effect.fail(issue(message, input));

/**
 * Text behind a fixed anti-JSON-hijacking prefix. Decoding requires the exact prefix, because text
 * without it did not come from the guarded endpoint; encoding writes it back.
 */
export const prefixed = (prefix: string) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformEffect({
        decode: (wire: string) =>
          wire.startsWith(prefix)
            ? Effect.succeed(wire.slice(prefix.length))
            : fail(
                `expected the anti-hijacking prefix ${JSON.stringify(prefix)}`,
                wire,
              ),
        encode: (body: string) => Effect.succeed(`${prefix}${body}`),
      }),
    ),
  );

const identifier = /^[A-Za-z_$][\w$]*$/;

/** A JSONP callback name: a plain JavaScript identifier, nothing a script could abuse. */
export const CallbackName = Schema.String.check(
  Schema.isPattern(identifier, {
    message: "a JSONP callback must be an identifier",
  }),
);

/**
 * JSON text inside Express's JSONP frame, `/**\/ typeof cb === 'function' && cb(<json>);`, for one
 * expected callback name. A frame for any other name is a decoding failure: it answers somebody
 * else's request.
 */
export const jsonp = (callback: string) => {
  const frame =
    /^\/\*\*\/ typeof ([A-Za-z_$][\w$]*) === 'function' && ([A-Za-z_$][\w$]*)\(([\s\S]*)\);$/;
  return Schema.String.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformEffect({
        decode: (wire: string) => {
          const match = frame.exec(wire);
          if (match === null)
            return fail("expected an Express JSONP frame", wire);
          const [, guarded, called, body] = match;
          if (guarded !== callback || called !== callback)
            return fail(
              `the JSONP frame calls ${String(called)}, not the requested ${callback}`,
              wire,
            );
          return Effect.succeed(body ?? "");
        },
        encode: (body: string) =>
          identifier.test(callback)
            ? Effect.succeed(
                `/**/ typeof ${callback} === 'function' && ${callback}(${body});`,
              )
            : fail(`a JSONP callback must be an identifier: ${callback}`, body),
      }),
    ),
  );
};

/*
 * Lossless JSON. Node implements JSON.parse source text access and JSON.rawJSON (TC39, shipped in
 * V8 11.4); TypeScript's lib does not type them yet.
 */
interface ReviverContext {
  readonly source?: string;
}
type Reviver = (
  key: string,
  value: unknown,
  context?: ReviverContext,
) => unknown;
const rawJson = (
  JSON as unknown as { readonly rawJSON?: (text: string) => unknown }
).rawJSON;

const exactIntegers: Reviver = (_, value, context) =>
  typeof value === "number" &&
  !Number.isSafeInteger(value) &&
  context?.source !== undefined &&
  /^-?\d+$/.test(context.source)
    ? BigInt(context.source)
    : value;

const integerDigits = (_: string, value: unknown): unknown => {
  if (typeof value !== "bigint") return value;
  if (rawJson === undefined) throw new Error("JSON.rawJSON is unavailable");
  return rawJson(value.toString());
};

/**
 * JSON text parsed so that integer literals outside the safe range arrive as exact `bigint`s instead
 * of rounded numbers, and `bigint`s encode back as bare digits. Everything else parses as usual.
 */
export const losslessJson = <S extends Schema.Constraint>(schema: S) => {
  if (rawJson === undefined)
    throw new Error("this platform cannot parse JSON losslessly");
  return Schema.fromJsonString(schema, {
    reviver: exactIntegers as Parameters<typeof JSON.parse>[1],
    replacer: integerDigits,
  });
};

const safeMinimum = BigInt(Number.MIN_SAFE_INTEGER);
const safeMaximum = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * A 64-bit identifier: an exact `bigint` from {@link losslessJson}, or a safe integer. A number the
 * platform parser already rounded is refused, so a lossy parse cannot pass silently. Encoding writes
 * safe values back as numbers, the canonical spelling.
 */
export const ExactId = Schema.Union([
  Schema.BigInt.check(Schema.isGreaterThanBigInt(0n)),
  Schema.Int.check(Schema.isGreaterThan(0)),
]).pipe(
  Schema.decodeTo(
    Schema.BigInt,
    SchemaTransformation.transform({
      decode: (value: bigint | number) => BigInt(value),
      encode: (value: bigint) =>
        value >= safeMinimum && value <= safeMaximum ? Number(value) : value,
    }),
  ),
);

/**
 * A count that OData v2 sends as a decimal string. Only canonical digits are accepted: no sign,
 * padding, leading zeros, or fraction.
 */
export const CountFromString = Schema.String.check(
  Schema.isPattern(/^(0|[1-9]\d{0,14})$/, {
    message: "a count is canonical decimal digits",
  }),
).pipe(
  Schema.decodeTo(
    Schema.Int,
    SchemaTransformation.transform({
      decode: (value: string) => Number(value),
      encode: (value: number) => String(value),
    }),
  ),
);

/**
 * A column-oriented grid, `{ columns, rows }`, read as records. The column header is verified, not
 * trusted: it must name every expected column exactly once and nothing else, in any order, and every
 * row must have one cell per column. Encoding writes the expected column order.
 */
export const grid = <Row extends Schema.Top>(
  row: Row,
  columns: ReadonlyArray<string>,
) =>
  Schema.Struct({
    columns: Schema.Array(Schema.String),
    rows: Schema.Array(Schema.Array(Schema.Unknown)),
  }).pipe(
    Schema.decodeTo(Schema.Array(row), {
      decode: SchemaGetter.transformEffect(
        (wire: {
          readonly columns: ReadonlyArray<string>;
          readonly rows: ReadonlyArray<ReadonlyArray<unknown>>;
        }) => {
          const positions = new Map<string, number>();
          for (const [index, name] of wire.columns.entries()) {
            if (positions.has(name))
              return fail(`column ${name} appears twice`, wire);
            if (!columns.includes(name))
              return fail(`unexpected column ${name}`, wire);
            positions.set(name, index);
          }
          const missing = columns.filter((name) => !positions.has(name));
          if (missing.length > 0)
            return fail(`missing column ${missing.join(", ")}`, wire);
          const records: Array<Record<string, unknown>> = [];
          for (const [index, cells] of wire.rows.entries()) {
            if (cells.length !== wire.columns.length)
              return fail(
                `row ${index} has ${cells.length} cells for ${wire.columns.length} columns`,
                wire,
              );
            records.push(
              Object.fromEntries(
                columns.map((name) => [name, cells[positions.get(name)!]]),
              ),
            );
          }
          return Effect.succeed(records as unknown as Row["Encoded"][]);
        },
      ),
      encode: SchemaGetter.transform(
        (records: ReadonlyArray<Row["Encoded"]>) => ({
          columns,
          rows: records.map((record) =>
            columns.map((name) => (record as Record<string, unknown>)[name]),
          ),
        }),
      ),
    }),
  );

/**
 * A list that an XML-to-JSON bridge unwraps: absent for none, a bare item for one, an array for two
 * or more. Use it with `Schema.optionalKey` semantics: it decodes an absent key to an empty array and
 * encodes an empty array as an absent key. An array of fewer than two items is not the bridge's
 * spelling and is refused, which keeps the mapping reversible.
 */
export const unwrappedList = <Item extends Schema.Top>(item: Item) =>
  Schema.optionalKey(
    Schema.Union([Schema.Array(item).check(Schema.isMinLength(2)), item]),
  ).pipe(
    Schema.decodeTo(
      Schema.Array(Schema.toType(item)),
      SchemaTransformation.transformOptional({
        decode: (wire) =>
          Option.some(
            Option.match(wire, {
              onNone: () => [],
              onSome: (value) =>
                Array.isArray(value)
                  ? (value as ReadonlyArray<Item["Type"]>)
                  : [value as Item["Type"]],
            }),
          ),
        encode: (list) =>
          Option.flatMap(list, (items) =>
            items.length === 0
              ? Option.none()
              : Option.some(items.length === 1 ? items[0]! : items),
          ),
      }),
    ),
  );

/** One link of a `Link` header. */
export interface Link {
  readonly target: string;
  readonly rel: string;
}

const linkPattern = /^<([^<>\s]*)>; rel="([a-z]+)"$/;

/**
 * A `Link` header in the gateway's spelling, `<target>; rel="name"` joined by `, `, as ordered links.
 * Other spellings that RFC 8288 allows, such as unquoted relation names or extra parameters, are not
 * this gateway's and are refused, which keeps the mapping reversible.
 */
export const LinkHeader = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Array(Schema.Struct({ target: Schema.String, rel: Schema.String })),
    SchemaTransformation.transformEffect({
      decode: (wire: string) => {
        const links: Array<Link> = [];
        for (const part of wire.split(", ")) {
          const match = linkPattern.exec(part);
          if (match === null)
            return fail(`unexpected link ${JSON.stringify(part)}`, wire);
          links.push({ target: match[1]!, rel: match[2]! });
        }
        return Effect.succeed(links);
      },
      encode: (links: ReadonlyArray<Link>) =>
        Effect.succeed(
          links.map((link) => `<${link.target}>; rel="${link.rel}"`).join(", "),
        ),
    }),
  ),
);

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/** A zero-based window, as the gateway's link targets express it. */
export const Window = Schema.Struct({
  offset: NonNegativeInt,
  limit: PositiveInt,
});

/** A one-based page, as the customer listing's query parameters express it. */
export const Page = Schema.Struct({ page: PositiveInt, perPage: PositiveInt });

/** A zero-based offset window as a one-based page. Offsets between page boundaries are refused. */
export const PageFromWindow = Window.pipe(
  Schema.decodeTo(
    Page,
    SchemaTransformation.transformEffect({
      decode: (window: { readonly offset: number; readonly limit: number }) =>
        window.offset % window.limit === 0
          ? Effect.succeed({
              page: window.offset / window.limit + 1,
              perPage: window.limit,
            })
          : fail(
              `offset ${window.offset} is not on a page boundary of ${window.limit}`,
              window,
            ),
      encode: (page: { readonly page: number; readonly perPage: number }) =>
        Effect.succeed({
          offset: (page.page - 1) * page.perPage,
          limit: page.perPage,
        }),
    }),
  ),
);

/** A link target `<path>?offset=N&limit=M` as its window, in exactly the gateway's spelling. */
export const windowTarget = (path: string) => {
  const pattern = new RegExp(
    `^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?offset=(0|[1-9]\\d*)&limit=([1-9]\\d*)$`,
  );
  return Schema.String.pipe(
    Schema.decodeTo(
      Window,
      SchemaTransformation.transformEffect({
        decode: (target: string) => {
          const match = pattern.exec(target);
          return match === null
            ? fail(`expected ${path}?offset=N&limit=M`, target)
            : Effect.succeed({
                offset: Number(match[1]),
                limit: Number(match[2]),
              });
        },
        encode: (window: { readonly offset: number; readonly limit: number }) =>
          Effect.succeed(
            `${path}?offset=${window.offset}&limit=${window.limit}`,
          ),
      }),
    ),
  );
};

const relations = ["first", "prev", "next", "last"] as const;

/**
 * A pagination `Link` header for one collection path, as one-based pages: `first` and `last` always,
 * `prev` and `next` when present. Unknown or repeated relations are refused.
 */
export const pageLinks = (path: string) => {
  const target = windowTarget(path).pipe(Schema.decodeTo(PageFromWindow));
  return LinkHeader.pipe(
    Schema.decodeTo(
      Schema.Struct({
        first: target,
        prev: Schema.optionalKey(target),
        next: Schema.optionalKey(target),
        last: target,
      }),
      SchemaTransformation.transformEffect({
        decode: (links: ReadonlyArray<Link>) => {
          const byRelation: Record<string, string> = {};
          for (const link of links) {
            if (!(relations as ReadonlyArray<string>).includes(link.rel))
              return fail(`unexpected relation ${link.rel}`, links);
            if (link.rel in byRelation)
              return fail(`relation ${link.rel} appears twice`, links);
            byRelation[link.rel] = link.target;
          }
          const { first, last } = byRelation;
          if (first === undefined || last === undefined)
            return fail("first and last links are required", links);
          return Effect.succeed({
            ...byRelation,
            first,
            last,
          } as { first: string; prev?: string; next?: string; last: string });
        },
        encode: (pages: {
          readonly first: string;
          readonly prev?: string;
          readonly next?: string;
          readonly last: string;
        }) =>
          Effect.succeed(
            relations.flatMap((rel) => {
              const linked = pages[rel];
              return linked === undefined ? [] : [{ target: linked, rel }];
            }),
          ),
      }),
    ),
  );
};

/**
 * A `Location` value resolved against the URL of the request it answered (RFC 9110, section 10.2.2).
 * The container chose the relative or absolute spelling, and a resolved URL cannot recover that
 * choice, so encoding is refused.
 */
export const locationAgainst = (requestUrl: string) =>
  Schema.String.pipe(
    Schema.decodeTo(Schema.instanceOf(URL), {
      decode: SchemaGetter.transformEffect((location: string) =>
        Effect.try({
          try: () => new URL(location, requestUrl),
          catch: () =>
            issue(
              `unresolvable Location ${JSON.stringify(location)}`,
              location,
            ),
        }),
      ),
      encode: SchemaGetter.forbidden(
        () =>
          "a resolved Location cannot be encoded: the container's relative or absolute spelling is lost",
      ),
    }),
  );
