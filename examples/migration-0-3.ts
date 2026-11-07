import assert from "node:assert/strict";
import { Option } from "effect";
// #region imports
import { Effect, Schema } from "effect";
import { Body, Policy, Request } from "viell-effect-schema-http";
// #endregion imports

const urlOf = async <I, E>(request: Request.Request<I, E>, input: I) =>
  (await Effect.runPromise(Request.compile(request, input))).request.url;

/** What the input's schema said, before anything was sent. */
const refusedFor = async <I, E>(request: Request.Request<I, E>, input: I) => {
  const error = await Effect.runPromise(
    Effect.flip(Request.compile(request, input)),
  );
  assert.ok(error instanceof Schema.SchemaError);
  return error.message;
};

const things = "https://api.example.test/things";

// The definition compiles and is unchanged. Whether it fails depends on the values.
const EitherFilter = Schema.Union([
  Schema.Struct({ owner: Schema.String }),
  Schema.Struct({ team: Schema.String }),
]);
const unchanged = Request.get(things).pipe(Request.query(EitherFilter));
assert.equal(
  await urlOf(unchanged, { query: { owner: "ada" } }),
  `${things}?owner=ada`,
);
assert.equal(
  await urlOf(unchanged, { query: { team: "core" } }),
  `${things}?team=core`,
);
const refusal = await refusedFor(unchanged, {
  query: { owner: "ada", team: "core" },
});
assert.match(refusal, /No union member holds this field/);
assert.match(refusal, /\["team"\]/);

// `undefined` holds no value to lose, so a value built from optional fields keeps working.
assert.equal(
  await urlOf(unchanged, { query: { owner: "ada", team: undefined } }),
  `${things}?owner=ada`,
);

// A key no member states is stripped, as a struct strips it.
const wider = { owner: "ada", page: "2" };
assert.equal(await urlOf(unchanged, { query: wider }), `${things}?owner=ada`);

// The refusal reaches into a body, where it names the whole path.
const inBody = await Effect.runPromise(
  Effect.flip(
    Body.jsonSchema(Schema.Struct({ filter: EitherFilter })).encode({
      filter: { owner: "ada", team: "core" },
    }),
  ),
);
assert.match(String(inBody), /\["filter"\]\["team"\]/);

// #region union-both
const Filter = Schema.Union([
  Schema.Struct({ owner: Schema.String }),
  Schema.Struct({ team: Schema.String }),
  Schema.Struct({ owner: Schema.String, team: Schema.String }),
]);
const search = Request.get(things).pipe(Request.query(Filter));
// Input: { query: { owner: "ada", team: "core" } }; URL query: ?owner=ada&team=core
// #endregion union-both
assert.equal(
  await urlOf(search, { query: { owner: "ada", team: "core" } }),
  `${things}?owner=ada&team=core`,
);
assert.equal(
  await urlOf(search, { query: { team: "core" } }),
  `${things}?team=core`,
);

// #region union-one
const onlyOwner = ({
  owner,
}: {
  readonly owner: string;
  readonly team: string;
}) => ({ query: { owner } });
const searchByOwner = Request.get(things).pipe(
  Request.query(EitherFilter),
  Request.mapInput(onlyOwner),
);
// Input: { owner: "ada", team: "core" }; URL query: ?owner=ada
// #endregion union-one
assert.equal(
  await urlOf(searchByOwner, { owner: "ada", team: "core" }),
  `${things}?owner=ada`,
);

// A value a wider member refuses used to go with the field, and is now refused.
const Limited = Schema.Union([
  Schema.Struct({ owner: Schema.String }),
  Schema.Struct({ owner: Schema.String, limit: Schema.FiniteFromString }),
]);
const limited = Request.get(things).pipe(Request.query(Limited));
assert.match(
  await refusedFor(limited, { query: { owner: "ada", limit: "many" } }),
  /\["limit"\]/,
);
assert.equal(
  await urlOf(limited, { query: { owner: "ada", limit: "5" } }),
  `${things}?owner=ada&limit=5`,
);

// A stacked schema that takes the field needs no change, in either order.
const Teams = Schema.Struct({ team: Schema.String });
assert.equal(
  await urlOf(
    Request.get(things).pipe(Request.query(EitherFilter), Request.query(Teams)),
    { query: { owner: "ada", team: "core" } },
  ),
  `${things}?owner=ada&team=core`,
);
assert.equal(
  await urlOf(
    Request.get(things).pipe(Request.query(Teams), Request.query(EitherFilter)),
    { query: { owner: "ada", team: "core" } },
  ),
  `${things}?team=core&owner=ada`,
);

// The other half of the same change: a field a narrower first member used to drop now goes out.
const NarrowFirst = Schema.Union([
  Schema.Struct({ owner: Schema.String }),
  Schema.Struct({ owner: Schema.String, team: Schema.String }),
]);
assert.equal(
  await urlOf(Request.get(things).pipe(Request.query(NarrowFirst)), {
    query: { owner: "ada", team: "core" },
  }),
  `${things}?owner=ada&team=core`,
);
// A raw value under that name no longer takes the caller's place.
assert.equal(
  await urlOf(
    Request.get(`${things}?team=raw`).pipe(Request.query(NarrowFirst)),
    {
      query: { owner: "ada", team: "core" },
    },
  ),
  `${things}?owner=ada&team=core`,
);

// #region union-narrow
const ownerOnly = ({ owner }: { readonly owner: string }) => ({
  query: { owner },
});
const searchOwner = Request.get(things).pipe(
  Request.query(NarrowFirst),
  Request.mapInput(ownerOnly),
);
// A value that holds more goes out as ?owner=ada, as it did on 0.2.
// #endregion union-narrow
const heldMore = { owner: "ada", team: "core" };
assert.equal(await urlOf(searchOwner, heldMore), `${things}?owner=ada`);

const withDefault = Schema.FiniteFromString.pipe(
  Schema.withDecodingDefaultKey(Effect.succeed("25")),
);

// The edit compiled and was lost on 0.2. It now fails on every run, whatever the input.
const edited = Request.get(things).pipe(
  Request.query(Schema.Struct({ limit: withDefault })),
  Request.setQuery("limit", "50"),
);
for (const query of [{}, { limit: 10 }]) {
  const error = await Effect.runPromise(
    Effect.flip(Request.compile(edited, { query })),
  );
  assert.ok(error instanceof Request.InvalidRequest);
  assert.match(error.message, /could never reach the client: "limit"/);
}

// #region default-removed
const Paging = Schema.Struct({
  limit: Schema.FiniteFromString.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("25")),
  ),
});
const listThings = Request.get(things).pipe(Request.query(Paging));
// Input: { query: {} }; URL query: ?limit=25, which is what went out on 0.2
// #endregion default-removed
assert.equal(await urlOf(listThings, { query: {} }), `${things}?limit=25`);
assert.equal(
  await urlOf(listThings, { query: { limit: 10 } }),
  `${things}?limit=10`,
);

// #region default-optional
const OptionalPaging = Schema.Struct({
  limit: Schema.optionalKey(Schema.FiniteFromString),
});
const listFifty = Request.get(things).pipe(
  Request.query(OptionalPaging),
  Request.setQuery("limit", "50"),
);
// Input: { query: {} }; URL query: ?limit=50
// Input: { query: { limit: 10 } }; URL query: ?limit=10
// #endregion default-optional
assert.equal(await urlOf(listFifty, { query: {} }), `${things}?limit=50`);
assert.equal(
  await urlOf(listFifty, { query: { limit: 10 } }),
  `${things}?limit=10`,
);

// #region default-fixed
const listAlwaysFifty = listThings.pipe(
  Request.mapInput(() => ({ query: { limit: 50 } })),
);
// Input: undefined; URL query: ?limit=50
// #endregion default-fixed
assert.equal(await urlOf(listAlwaysFifty, undefined), `${things}?limit=50`);

// A raw value before the schema is no way out: the schema's own default replaces it.
assert.equal(
  await urlOf(Request.get(`${things}?limit=50`).pipe(Request.query(Paging)), {
    query: {},
  }),
  `${things}?limit=25`,
);

// An Option may write nothing, so an edit of one stays allowed.
const MaybeLimit = Schema.Struct({
  limit: Schema.OptionFromOptionalKey(Schema.String),
});
assert.equal(
  await urlOf(
    Request.get(things).pipe(
      Request.query(MaybeLimit),
      Request.setQuery("limit", "50"),
    ),
    { query: { limit: Option.none() } },
  ),
  `${things}?limit=50`,
);

// A `Schema.Struct({})` member takes any value and keeps it, so it wins over a member that strips.
const Anything = Schema.Union([
  Schema.Struct({ owner: Schema.String }),
  Schema.Struct({}),
]);
assert.equal(
  await urlOf(Request.get(things).pipe(Request.query(Anything)), {
    query: wider,
  }),
  `${things}?owner=ada&page=2`,
);

// #region policy-timeout
const oneQuickAttempt = Policy.timeout("5 seconds");
// #endregion policy-timeout
assert.equal(oneQuickAttempt.attemptTimeout, "5 seconds");
assert.equal(oneQuickAttempt.while, Policy.none.while);
