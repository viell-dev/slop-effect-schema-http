/**
 * EXT-30: a union's fields at the wire, in both lanes (#134, #120). The library's own tests and its
 * search state the rule: for values the library can see, a field a caller gave is kept or the
 * request is refused. These pin what arrives: every field, in the place the schema writes it, or
 * nothing at all and an error that names the field and not its value. The tests marked `limit` pin
 * where the rule stops, inside a value the library cannot see, as `docs/design.md` states.
 *
 * The server's answer is not the point, so these use `echo`, which answers with 404 and the text
 * `Not Found`, and the socket listener, which keeps each target as it arrived.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Schema, SchemaGetter } from "effect";
import { lane } from "#lane";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { bodyText, headerValues } from "../harness/lane.js";

const notFound = Response.status(404, Body.text);

const start = () => lane.backend("echo", undefined, { listener: "socket" });

const at = (origin: string) => Request.get(`${origin}/x`);
const postTo = (origin: string) => Request.post(`${origin}/x`);

const sent = <I, E>(
  build: (origin: string) => Request.Request<I, E>,
  input: I,
) =>
  Effect.gen(function* () {
    const echo = yield* start();
    yield* Operation.make(build(echo.origin), notFound)
      .execute(input)
      .pipe(Effect.provide(lane.fetchClient));
    return yield* echo.ledger;
  });

/** The failure of a call that must not reach the server, with the ledger that shows it did not. */
const refused = <I, E>(
  build: (origin: string) => Request.Request<I, E>,
  input: I,
) =>
  Effect.gen(function* () {
    const echo = yield* start();
    const error = yield* Operation.make(build(echo.origin), notFound)
      .execute(input)
      .pipe(Effect.provide(lane.fetchClient), Effect.flip);
    return { error, ledger: yield* echo.ledger };
  });

const secret = "hidden-value";

const Owner = Schema.Struct({ owner: Schema.String });
const Team = Schema.Struct({ team: Schema.String });
const OwnerThenWider = Schema.Union([
  Owner,
  Schema.Struct({ owner: Schema.String, limit: Schema.String }),
]);
const OwnerOrTeam = Schema.Union([Owner, Team]);
const OwnerAndLimit = Schema.Struct({
  owner: Schema.String,
  limit: Schema.String,
});
const Renamed = Schema.Struct({ a: Schema.String, b: Schema.String }).pipe(
  Schema.encodeKeys({ a: "A", b: "B" }),
);

const RenamedOptional = Schema.Struct({
  a: Schema.optionalKey(Schema.String),
  b: Schema.optionalKey(Schema.String),
}).pipe(Schema.encodeKeys({ a: "A", b: "B" }));

/** The union above with a default for `limit`, written in the constructor. */
const withRawLimit = (origin: string) =>
  Request.get(`${origin}/x?limit=1`).pipe(Request.query(OwnerThenWider));

const OwnerHeader = Schema.Struct({ "X-Owner": Schema.String });
const WiderHeader = Schema.Struct({
  "X-Owner": Schema.String,
  "X-Team": Schema.String,
});

describe(`a union's fields at the wire (${lane.name})`, () => {
  it.live(
    "[EXT-30a] a narrower member first still sends every query field the caller gave",
    () =>
      Effect.gen(function* () {
        const [entry] = yield* sent(
          (origin) => at(origin).pipe(Request.query(OwnerThenWider)),
          { query: { owner: "ada", limit: "5" } },
        );
        expect(entry!.target).toBe("/x?owner=ada&limit=5");
      }),
  );

  it.live(
    "[EXT-30a] a narrower member first still sends every header the caller gave",
    () =>
      Effect.gen(function* () {
        const [entry] = yield* sent(
          (origin) =>
            at(origin).pipe(
              Request.headers(Schema.Union([OwnerHeader, WiderHeader])),
            ),
          { headers: { "X-Owner": "ada", "X-Team": "core" } },
        );
        expect(headerValues(entry!.lines, "x-owner")).toEqual(["ada"]);
        expect(headerValues(entry!.lines, "x-team")).toEqual(["core"]);
      }),
  );

  it.live(
    "[EXT-30a] a narrower member first still sends every field of a nested JSON body",
    () =>
      Effect.gen(function* () {
        const [entry] = yield* sent(
          (origin) =>
            postTo(origin).pipe(
              Request.body(
                Body.jsonSchema(
                  Schema.Struct({
                    filters: Schema.Array(
                      Schema.Struct({ filter: OwnerThenWider }),
                    ),
                  }),
                ),
              ),
            ),
          {
            body: {
              filters: [
                { filter: { owner: "ada" } },
                { filter: { owner: "grace", limit: "5" } },
              ],
            },
          },
        );
        expect(JSON.parse(bodyText(entry!))).toEqual({
          filters: [
            { filter: { owner: "ada" } },
            { filter: { owner: "grace", limit: "5" } },
          ],
        });
      }),
  );

  it.live(
    "[EXT-30b] a raw default stays when the caller leaves its field out, and goes when the caller gives it",
    () =>
      Effect.gen(function* () {
        const [left] = yield* sent(withRawLimit, { query: { owner: "ada" } });
        const [given] = yield* sent(withRawLimit, {
          query: { owner: "ada", limit: "5" },
        });
        expect(left!.target).toBe("/x?owner=ada&limit=1");
        expect(given!.target).toBe("/x?owner=ada&limit=5");
      }),
  );

  it.live(
    "[EXT-30c] fields no member can hold together are refused in a query, by name and never by value, and nothing is sent",
    () =>
      Effect.gen(function* () {
        const { error, ledger } = yield* refused(
          (origin) => at(origin).pipe(Request.query(OwnerOrTeam)),
          { query: { owner: "ada", team: secret } },
        );
        expect(error._tag).toBe("SchemaError");
        expect(error.message).toContain('"team"');
        expect(error.message).not.toContain(secret);
        expect(ledger).toEqual([]);
      }),
  );

  it.live(
    "[EXT-30c] fields no member can hold together are refused in a body, by their whole path, and nothing is sent",
    () =>
      Effect.gen(function* () {
        const { error, ledger } = yield* refused(
          (origin) =>
            postTo(origin).pipe(
              Request.body(
                Body.jsonSchema(Schema.Struct({ filter: OwnerOrTeam })),
              ),
            ),
          { body: { filter: { owner: "ada", team: secret } } },
        );
        expect(error._tag).toBe("SchemaError");
        expect(error.message).toContain('["filter"]["team"]');
        expect(error.message).not.toContain(secret);
        expect(ledger).toEqual([]);
      }),
  );

  it.live(
    "[EXT-30d] a union stacked with a struct sends both fields, in either order",
    () =>
      Effect.gen(function* () {
        const [unionFirst] = yield* sent(
          (origin) =>
            at(origin).pipe(Request.query(OwnerOrTeam), Request.query(Team)),
          { query: { owner: "ada", team: "core" } },
        );
        const [structFirst] = yield* sent(
          (origin) =>
            at(origin).pipe(Request.query(Team), Request.query(OwnerOrTeam)),
          { query: { owner: "ada", team: "core" } },
        );
        for (const entry of [unionFirst, structFirst]) {
          const params = new URLSearchParams(entry!.target.split("?")[1]);
          expect(params.getAll("owner")).toEqual(["ada"]);
          expect(params.getAll("team")).toEqual(["core"]);
        }
      }),
  );

  it.live(
    "[EXT-30e] two stacked unions that each state a field leave it to neither, and are refused",
    () =>
      Effect.gen(function* () {
        const { error, ledger } = yield* refused(
          (origin) =>
            at(origin).pipe(
              Request.query(OwnerOrTeam),
              Request.query(
                Schema.Union([
                  Schema.Struct({ owner: Schema.String }),
                  Schema.Struct({ limit: Schema.String }),
                ]),
              ),
            ),
          { query: { owner: "ada", team: secret, limit: secret } },
        );
        expect(error._tag).toBe("SchemaError");
        expect(error.message).not.toContain(secret);
        expect(ledger).toEqual([]);
      }),
  );

  it.live(
    "[EXT-30f] a raw edit of a field with a decoding default is refused before anything is sent",
    () =>
      Effect.gen(function* () {
        const { error, ledger } = yield* refused(
          (origin) =>
            at(origin).pipe(
              Request.query(
                Schema.Struct({
                  limit: Schema.String.pipe(
                    Schema.withDecodingDefaultKey(Effect.succeed("25")),
                  ),
                }),
              ),
              Request.setQuery("limit", secret),
            ),
          { query: {} },
        );
        expect(error._tag).toBe("InvalidRequest");
        expect(error.message).toContain('"limit"');
        expect(error.message).toContain("could never reach the client");
        expect(error.message).not.toContain(secret);
        expect(ledger).toEqual([]);
      }),
  );

  it.live(
    "[EXT-30f] control: the same edit before the schema is an ordinary default, and the schema's value goes out",
    () =>
      Effect.gen(function* () {
        const [entry] = yield* sent(
          (origin) =>
            at(origin).pipe(
              Request.setQuery("limit", "5"),
              Request.query(
                Schema.Struct({
                  limit: Schema.String.pipe(
                    Schema.withDecodingDefaultKey(Effect.succeed("25")),
                  ),
                }),
              ),
            ),
          { query: {} },
        );
        expect(entry!.target).toBe("/x?limit=25");
      }),
  );

  it.live(
    "[EXT-30g] control: under the omit strategy the schema never writes the name, so the same edit is refused as lost",
    () =>
      Effect.gen(function* () {
        const { error, ledger } = yield* refused(
          (origin) =>
            at(origin).pipe(
              Request.query(
                Schema.Struct({
                  limit: Schema.String.pipe(
                    Schema.withDecodingDefaultKey(Effect.succeed("25"), {
                      encodingStrategy: "omit",
                    }),
                  ),
                }),
              ),
              Request.setQuery("limit", secret),
            ),
          { query: {} },
        );
        expect(error._tag).toBe("InvalidRequest");
        expect(error.message).toContain("would be lost");
        expect(error.message).not.toContain(secret);
        expect(ledger).toEqual([]);
      }),
  );

  it.live(
    "[EXT-30g] control: an optional field that reads absence as None leaves a raw edit to stand",
    () =>
      Effect.gen(function* () {
        const Reads = Schema.Struct({
          limit: Schema.OptionFromOptionalKey(Schema.String),
        });
        const [entry] = yield* sent(
          (origin) =>
            at(origin).pipe(
              Request.query(Reads),
              Request.setQuery("limit", "5"),
            ),
          { query: { limit: Option.none() } },
        );
        expect(entry!.target).toBe("/x?limit=5");
      }),
  );

  it.live(
    "[EXT-30h] a wider member wins under OptionFromNullOr and under an object given to a field that holds JSON, because a side of each schema states it",
    () =>
      Effect.gen(function* () {
        const [inOption] = yield* sent(
          (origin) =>
            postTo(origin).pipe(
              Request.body(
                Body.jsonSchema(
                  Schema.Struct({
                    filter: Schema.OptionFromNullOr(OwnerThenWider),
                  }),
                ),
              ),
            ),
          { body: { filter: Option.some({ owner: "ada", limit: "5" }) } },
        );
        expect(JSON.parse(bodyText(inOption!))).toEqual({
          filter: { owner: "ada", limit: "5" },
        });
        const [inField] = yield* sent(
          (origin) =>
            at(origin).pipe(
              Request.query(
                Schema.Struct({
                  filter: Schema.fromJsonString(OwnerThenWider),
                }),
              ),
            ),
          { query: { filter: { owner: "ada", limit: "5" } } },
        );
        const params = new URLSearchParams(inField!.target.split("?")[1]);
        expect(JSON.parse(params.get("filter")!)).toEqual({
          owner: "ada",
          limit: "5",
        });
      }),
  );

  it.live(
    "[EXT-30h] fields no member can hold together are refused under OptionFromNullOr, and nothing is sent",
    () =>
      Effect.gen(function* () {
        const { error, ledger } = yield* refused(
          (origin) =>
            postTo(origin).pipe(
              Request.body(
                Body.jsonSchema(
                  Schema.Struct({
                    filter: Schema.OptionFromNullOr(OwnerOrTeam),
                  }),
                ),
              ),
            ),
          { body: { filter: Option.some({ owner: "ada", team: secret }) } },
        );
        expect(error._tag).toBe("SchemaError");
        expect(error.message).toContain('["filter"]["value"]["team"]');
        expect(error.message).not.toContain(secret);
        expect(ledger).toEqual([]);
      }),
  );

  it.live(
    "[EXT-30h] fields no member can hold together are refused in an object given to a field that holds JSON, and nothing is sent",
    () =>
      Effect.gen(function* () {
        const { error, ledger } = yield* refused(
          (origin) =>
            at(origin).pipe(
              Request.query(
                Schema.Struct({ filter: Schema.fromJsonString(OwnerOrTeam) }),
              ),
            ),
          { query: { filter: { owner: "ada", team: secret } } },
        );
        expect(error._tag).toBe("SchemaError");
        expect(error.message).toContain('["filter"]["team"]');
        expect(error.message).not.toContain(secret);
        expect(ledger).toEqual([]);
      }),
  );

  it.live(
    "[EXT-30i] limit: fields no member can hold together in text given as text are not refused, and the first member's go out",
    () =>
      Effect.gen(function* () {
        const [entry] = yield* sent(
          (origin) =>
            at(origin).pipe(
              Request.query(
                Schema.Struct({ filter: Schema.fromJsonString(OwnerOrTeam) }),
              ),
            ),
          { query: { filter: '{"owner":"ada","team":"core"}' } },
        );
        const params = new URLSearchParams(entry!.target.split("?")[1]);
        expect(JSON.parse(params.get("filter")!)).toEqual({ owner: "ada" });
      }),
  );

  it.live(
    "[EXT-30i] limit: fields no member can hold together inside Schema.Option are not refused, and the first member's go out",
    () =>
      Effect.gen(function* () {
        const [entry] = yield* sent(
          (origin) =>
            postTo(origin).pipe(
              Request.body(
                Body.jsonSchema(
                  Schema.Struct({ filter: Schema.Option(OwnerOrTeam) }),
                ),
              ),
            ),
          { body: { filter: Option.some({ owner: "ada", team: "core" }) } },
        );
        const text = bodyText(entry!);
        expect(text).toContain("ada");
        expect(text).not.toContain("core");
      }),
  );

  it.live(
    "[EXT-30j] limit: a stray key inside an Option beside a visible union makes the union read loosely, so a wider member's field is refused, and nothing is sent",
    () =>
      Effect.gen(function* () {
        const { error, ledger } = yield* refused(
          (origin) =>
            postTo(origin).pipe(
              Request.body(
                Body.jsonSchema(
                  Schema.Struct({
                    held: Schema.OptionFromNullOr(Owner),
                    filter: OwnerThenWider,
                  }),
                ),
              ),
            ),
          {
            body: {
              held: Option.some({ owner: "ada", stray: secret }),
              filter: { owner: "grace", limit: secret },
            },
          },
        );
        expect(error._tag).toBe("SchemaError");
        expect(error.message).toContain('["filter"]["limit"]');
        expect(error.message).not.toContain(secret);
        expect(ledger).toEqual([]);
      }),
  );

  it.live(
    "[EXT-30k] names from two sides of a renamed struct are refused, by name and never by value, and nothing is sent",
    () =>
      Effect.gen(function* () {
        const { error, ledger } = yield* refused(
          (origin) => at(origin).pipe(Request.query(RenamedOptional)),
          { query: { a: "1", B: secret } as never },
        );
        expect(error._tag).toBe("SchemaError");
        expect(error.message).toContain('"B"');
        expect(error.message).not.toContain(secret);
        expect(ledger).toEqual([]);
      }),
  );

  it.live(
    "[EXT-30k] control: each side of the renamed struct alone goes out under the wire names",
    () =>
      Effect.gen(function* () {
        const [decoded] = yield* sent(
          (origin) => at(origin).pipe(Request.query(Renamed)),
          { query: { a: "1", b: "2" } },
        );
        const [encoded] = yield* sent(
          (origin) => at(origin).pipe(Request.query(Renamed)),
          { query: { A: "1", B: "2" } },
        );
        expect(decoded!.target).toBe("/x?A=1&B=2");
        expect(encoded!.target).toBe("/x?A=1&B=2");
      }),
  );

  it.live(
    "[EXT-30l] limit: one field under both of its names under different values keeps the decoded name's, with no error",
    () =>
      Effect.gen(function* () {
        const [entry] = yield* sent(
          (origin) => at(origin).pipe(Request.query(Renamed)),
          { query: { a: "1", b: "2", A: "lost" } as never },
        );
        expect(entry!.target).toBe("/x?A=1&B=2");
      }),
  );

  it.live(
    "[EXT-30m] a value a wider member refuses is refused, and is not cut down to the narrower member",
    () =>
      Effect.gen(function* () {
        const { error, ledger } = yield* refused(
          (origin) =>
            at(origin).pipe(
              Request.query(
                Schema.Union([
                  Owner,
                  Schema.Struct({
                    owner: Schema.String,
                    limit: Schema.FiniteFromString,
                  }),
                ]),
              ),
            ),
          { query: { owner: "ada", limit: secret as never } },
        );
        expect(error._tag).toBe("SchemaError");
        expect(error.message).toContain('"limit"');
        expect(error.message).not.toContain(secret);
        expect(ledger).toEqual([]);
      }),
  );

  it.live(
    "[EXT-30n] a key set to undefined under a union is no field, so the request goes out without it",
    () =>
      Effect.gen(function* () {
        const [entry] = yield* sent(
          (origin) => at(origin).pipe(Request.query(OwnerOrTeam)),
          { query: { owner: "ada", team: undefined } as never },
        );
        expect(entry!.target).toBe("/x?owner=ada");
      }),
  );

  it.live(
    "[EXT-30o] a tag has already chosen, so a key only another tag's member states goes, with no error",
    () =>
      Effect.gen(function* () {
        const Tagged = Schema.Union([
          Schema.Struct({ kind: Schema.Literal("a"), note: Schema.String }),
          Schema.Struct({ kind: Schema.Literal("b") }),
        ]);
        const [entry] = yield* sent(
          (origin) =>
            postTo(origin).pipe(
              Request.body(Body.jsonSchema(Schema.Struct({ item: Tagged }))),
            ),
          { body: { item: { kind: "b", note: "another tag's" } as never } },
        );
        expect(JSON.parse(bodyText(entry!))).toEqual({ item: { kind: "b" } });
      }),
  );

  it.live(
    "[EXT-30p] limit: a union chooses before it knows what a stacked schema took, so its wider member is refused beside that schema",
    () =>
      Effect.gen(function* () {
        const { error, ledger } = yield* refused(
          (origin) =>
            at(origin).pipe(
              Request.query(Team),
              Request.query(Schema.Union([Team, OwnerAndLimit])),
            ),
          { query: { owner: "ada", limit: "5", team: "core" } },
        );
        expect(error._tag).toBe("SchemaError");
        expect(ledger).toEqual([]);
      }),
  );

  it.live(
    "[EXT-30p] control: bound directly, the member goes out whole beside that schema",
    () =>
      Effect.gen(function* () {
        const [entry] = yield* sent(
          (origin) =>
            at(origin).pipe(Request.query(Team), Request.query(OwnerAndLimit)),
          { query: { owner: "ada", limit: "5", team: "core" } },
        );
        const params = new URLSearchParams(entry!.target.split("?")[1]);
        expect(params.get("owner")).toBe("ada");
        expect(params.get("limit")).toBe("5");
        expect(params.get("team")).toBe("core");
      }),
  );

  it.live(
    "[EXT-30q] a value whose encode step drops a field is the schema's own decision, and goes out without it",
    () =>
      Effect.gen(function* () {
        const WriteOnly = Schema.Struct({
          owner: Schema.String,
          note: Schema.optionalKey(Schema.String).pipe(
            Schema.encodeTo(Schema.optionalKey(Schema.String), {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.omit(),
            }),
          ),
        });
        const [entry] = yield* sent(
          (origin) => at(origin).pipe(Request.query(WriteOnly)),
          { query: { owner: "ada", note: "kept here only" } },
        );
        expect(entry!.target).toBe("/x?owner=ada");
      }),
  );
});
