import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  flow,
  Option,
  Schema,
  SchemaGetter,
  SchemaTransformation,
} from "effect";
import { HttpClientRequest } from "effect/http";
import {
  compile,
  linesOf,
  Moment,
  MomentFromSelf,
  MomentFromString,
  notMoment,
  refusal,
  Tenant,
  urlOf,
} from "../../test/request.js";
import { bodyText } from "../../test/support.js";
import * as Body from "./Body.js";
import * as Request from "./Request.js";

/** The names a refusal lists after its last colon. */
const lostFrom = (message: string) =>
  JSON.parse(`[${message.slice(message.lastIndexOf(": ") + 2, -1)}]`);

/** Encodes to a number, so a default written as text is read as one first. */
const MomentFromNumber = Schema.Number.pipe(
  Schema.decodeTo(MomentFromSelf, {
    decode: SchemaGetter.transformEffect((minutes: number) =>
      Number.isInteger(minutes) && minutes >= 0
        ? Effect.succeed(new Moment(minutes))
        : notMoment(minutes),
    ),
    encode: SchemaGetter.transform((moment: Moment) => moment.minutes),
  }),
);

/** A native edit under a name, outside any schema's check. */
const appendTrace = (value: string) =>
  Request.mapEffect((request) =>
    Effect.succeed(HttpClientRequest.appendUrlParam(request, "trace", value)),
  );

/** Shared raw fields inside a generic function, a form that must keep compiling. */
const withService = <I, E, R>(request: Request.Request<I, E, R>) =>
  request.pipe(
    Request.setQuery("key", "abc"),
    Request.setHeader("X-Key", "abc"),
    Request.baseUrl("https://api.test"),
  );

/** `Request.unbind` inside a generic function, a form that must keep compiling. */
const withoutQuery = <I, E, R>(request: Request.Request<I, E, R>) =>
  request.pipe(Request.unbind("query"));

describe("a schema states the shape of its group", () => {
  const Authorization = { Authorization: Schema.optional(Schema.String) };
  const shared = Request.setHeader("Authorization", "Bearer shared");
  const Limit = Schema.Struct({
    limit: Schema.optional(Schema.FiniteFromString),
  });

  describe("a raw value under a name the schema allows", () => {
    it.effect("stays in place when an optional field is left out", () =>
      Effect.gen(function* () {
        const request = Request.put("/things").pipe(
          shared,
          Request.headers(
            Schema.Struct({ ...Authorization, "If-Match": Schema.String }),
          ),
        );
        expect(
          yield* linesOf(request, { headers: { "If-Match": "*" } }),
        ).toEqual([
          ["Authorization", "Bearer shared"],
          ["If-Match", "*"],
        ]);
      }),
    );

    it.effect("gives way to what the caller passes", () =>
      Effect.gen(function* () {
        const request = Request.put("/things").pipe(
          shared,
          Request.headers(Schema.Struct(Authorization)),
        );
        expect(
          yield* linesOf(request, {
            headers: { Authorization: "Bearer mine" },
          }),
        ).toEqual([["Authorization", "Bearer mine"]]);
      }),
    );

    it.effect("gives way to a required field, set before the schema", () =>
      Effect.gen(function* () {
        const request = Request.put("/things").pipe(
          shared,
          Request.headers(Schema.Struct({ Authorization: Schema.String })),
        );
        expect(
          yield* linesOf(request, {
            headers: { Authorization: "Bearer mine" },
          }),
        ).toEqual([["Authorization", "Bearer mine"]]);
      }),
    );

    // Raw defaults do not satisfy schema input; use a schema default or mapInput instead.
    // https://github.com/viell-dev/slop-effect-schema-http/issues/112
    it.effect(
      "requires caller input when only a raw default supplies a required field",
      () =>
        Effect.gen(function* () {
          const request = Request.put("/things").pipe(
            shared,
            Request.headers(Schema.Struct({ Authorization: Schema.String })),
          );
          const error = yield* Effect.flip(
            // @ts-expect-error the input comes from the schema alone
            compile(request, { headers: {} }),
          );
          expect(error).toBeInstanceOf(Schema.SchemaError);
        }),
    );

    it.effect("stays when the caller passes undefined for it", () =>
      Effect.gen(function* () {
        const request = Request.get("/things?limit=5").pipe(
          Request.query(Limit),
        );
        expect(yield* urlOf(request, { query: { limit: undefined } })).toBe(
          "/things?limit=5",
        );
      }),
    );

    it.effect("gives way to an empty list, which writes no entries", () =>
      Effect.gen(function* () {
        const request = Request.get("/things?tag=x").pipe(
          Request.query(
            Schema.Struct({
              tag: Schema.optional(Schema.Array(Schema.String)),
            }),
          ),
        );
        expect(yield* urlOf(request, { query: { tag: [] } })).toBe("/things");
      }),
    );

    it.effect("gives way to a value the schema supplies itself", () =>
      Effect.gen(function* () {
        const Constructed = Schema.Struct({
          limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
            Schema.withConstructorDefault(Effect.succeed(25)),
          ),
        });
        expect(
          yield* urlOf(
            Request.get("/things?limit=5").pipe(Request.query(Constructed)),
            { query: {} },
          ),
        ).toBe("/things?limit=25");
        const Decoded = Schema.Struct({
          limit: Schema.FiniteFromString.pipe(
            Schema.withDecodingDefaultKey(Effect.succeed("25")),
          ),
        });
        expect(
          yield* urlOf(
            Request.get("/things?limit=5").pipe(Request.query(Decoded)),
            { query: {} },
          ),
        ).toBe("/things?limit=25");
      }),
    );

    it.effect("stays under a field that encodes to nothing when left out", () =>
      Effect.gen(function* () {
        const request = Request.get("/things?limit=5").pipe(
          Request.query(
            Schema.Struct({
              limit: Schema.OptionFromOptionalKey(Schema.FiniteFromString),
            }),
          ),
        );
        expect(yield* urlOf(request, { query: {} })).toBe("/things?limit=5");
      }),
    );

    it.effect("is evaluated as a computed value, once", () =>
      Effect.gen(function* () {
        let calls = 0;
        const request = Request.get("/things").pipe(
          Request.setQuery("limit", () => `${++calls}`),
          Request.query(Limit),
        );
        expect(yield* urlOf(request, { query: {} })).toBe("/things?limit=1");
        expect(calls).toBe(1);
      }),
    );

    it.effect("wins over an automatic body field, in either order", () =>
      Effect.gen(function* () {
        const Type = Schema.Struct({
          "Content-Type": Schema.optional(Schema.String),
        });
        const declared = Request.post("/things").pipe(
          Request.setHeader("content-type", "application/weird"),
        );
        for (const request of [
          declared.pipe(Request.headers(Type), Request.body(Body.text)),
          declared.pipe(Request.body(Body.text), Request.headers(Type)),
        ]) {
          const compiled = yield* compile(request, { body: "b", headers: {} });
          expect(compiled.request.headers["content-type"]).toBe(
            "application/weird",
          );
          expect(compiled.headerLines).toContainEqual([
            "Content-Type",
            "application/weird",
          ]);
        }
      }),
    );
  });

  describe("a default goes through the schema", () => {
    it.effect("takes the form the schema writes", () =>
      Effect.gen(function* () {
        const Slot = Schema.Struct({ at: Schema.optional(MomentFromString) });
        const request = Request.get("/slots?at=t1530").pipe(
          Request.query(Slot),
        );
        expect(yield* urlOf(request, { query: {} })).toBe(
          "/slots?at=15%3A30%3A00",
        );
        expect(yield* urlOf(request, { query: { at: new Moment(930) } })).toBe(
          "/slots?at=15%3A30%3A00",
        );
      }),
    );

    it.effect("loses its exact text, as `?page=02` becomes `page=2`", () =>
      Effect.gen(function* () {
        const request = Request.get("/things?page=02&q=a+b").pipe(
          Request.query(
            Schema.Struct({
              page: Schema.optional(Schema.FiniteFromString),
              q: Schema.optional(Schema.String),
            }),
          ),
        );
        expect(yield* urlOf(request, { query: {} })).toBe(
          "/things?page=2&q=a%20b",
        );
      }),
    );

    it.effect("reads a written entry under its decoded name", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/things?%6Cimit=5").pipe(Request.query(Limit)),
            { query: {} },
          ),
        ).toBe("/things?limit=5");
        const Named = Schema.Struct({
          "first name": Schema.optional(Schema.String),
        });
        expect(
          yield* urlOf(
            Request.get("/x?first+name=Ada").pipe(Request.query(Named)),
            { query: {} },
          ),
        ).toBe("/x?first%20name=Ada");
      }),
    );

    it.effect("is refused when it does not fit", () =>
      Effect.gen(function* () {
        const bad = Request.get("/things?limit=many").pipe(
          Request.query(Limit),
        );
        const error = yield* refusal(bad, { query: {} });
        expect(error.message).toContain('"limit"');
        // The caller's value replaces it, so the default never comes into it.
        expect(yield* urlOf(bad, { query: { limit: 3 } })).toBe(
          "/things?limit=3",
        );
      }),
    );

    it.effect("is refused without its value, which may be a credential", () =>
      Effect.gen(function* () {
        const secret = "sk-not-a-real-secret";
        const Short = Schema.String.check(Schema.isMaxLength(5));
        const header = yield* refusal(
          Request.get("/things").pipe(
            Request.setHeader("X-Key", secret),
            Request.headers(Schema.Struct({ "X-Key": Schema.optional(Short) })),
          ),
          { headers: {} },
        );
        const query = yield* refusal(
          Request.get(`/things?key=${secret}`).pipe(
            Request.query(Schema.Struct({ key: Schema.optional(Short) })),
          ),
          { query: {} },
        );
        for (const error of [header, query]) {
          expect(error.cause).toBeUndefined();
          expect(`${error.message} ${String(error)}`).not.toContain(secret);
          expect(JSON.stringify(error)).not.toContain(secret);
        }
        expect(header.message).toContain('"X-Key"');
        expect(query.message).toContain('"key"');
      }),
    );

    it.effect(
      "is refused if the schema would not write it, so nothing is lost",
      () =>
        Effect.gen(function* () {
          const dropped = Schema.optionalKey(Schema.String).pipe(
            Schema.decodeTo(Schema.optionalKey(Schema.String), {
              decode: SchemaGetter.passthrough(),
              encode: SchemaGetter.omit(),
            }),
          );
          const query = Request.get("/things?gone=1").pipe(
            Request.query(Schema.Struct({ gone: dropped })),
          );
          expect((yield* refusal(query, { query: {} })).message).toContain(
            '"gone"',
          );
          const headers = Request.get("/things").pipe(
            Request.setHeader("X-Gone", "1"),
            Request.headers(Schema.Struct({ "X-Gone": dropped })),
          );
          expect((yield* refusal(headers, { headers: {} })).message).toContain(
            '"X-Gone"',
          );
        }),
    );

    it.effect(
      "is refused if the caller picks a union member that leaves it out",
      () =>
        Effect.gen(function* () {
          const Either = Schema.Union([
            Schema.Struct({ kind: Schema.Literal("a"), a: Schema.String }),
            Schema.Struct({ kind: Schema.Literal("b"), b: Schema.String }),
          ]);
          const request = Request.get("/things?b=1").pipe(
            Request.query(Either),
          );
          const error = yield* refusal(request, {
            query: { kind: "a", a: "x" },
          });
          expect(error.message).toContain('"b"');
          expect(yield* urlOf(request, { query: { kind: "b", b: "2" } })).toBe(
            "/things?kind=b&b=2",
          );
        }),
    );

    describe("under a union that a default and the caller split", () => {
      const Either = Schema.Union([
        Schema.Struct({ "x-a": Schema.String }),
        Schema.Struct({ "x-b": Schema.String }),
      ]);
      const AOrB = Schema.Union([
        Schema.Struct({ a: Schema.String }),
        Schema.Struct({ b: Schema.String }),
      ]);
      const Paged = Schema.Union([
        Schema.Struct({
          page: Schema.String,
          size: Schema.optional(Schema.String),
        }),
        Schema.Struct({ cursor: Schema.String }),
      ]);
      const PagedHeaders = Schema.Union([
        Schema.Struct({
          "x-page": Schema.String,
          "x-size": Schema.optional(Schema.String),
        }),
        Schema.Struct({ "x-cursor": Schema.String }),
      ]);

      it.effect("is refused for the header the caller would lose", () =>
        Effect.gen(function* () {
          const request = Request.get("/x").pipe(
            Request.setHeader("x-a", "default-a"),
            Request.headers(Either),
          );
          const error = yield* refusal(request, {
            headers: { "x-b": "from-caller" },
          });
          expect(lostFrom(error.message)).toEqual(["x-b"]);
          expect(error.message).toContain("header group");
          expect(`${error.message} ${String(error)}`).not.toContain(
            "default-a",
          );
          expect(`${error.message} ${String(error)}`).not.toContain(
            "from-caller",
          );
          expect(JSON.stringify(error)).not.toContain("from-caller");
          // The same call that fits the default's member still goes through.
          const compiled = yield* compile(request, {
            headers: { "x-a": "from-caller" },
          });
          expect(compiled.headerLines).toEqual([["x-a", "from-caller"]]);
        }),
      );

      it.effect("is refused for the query field the caller would lose", () =>
        Effect.gen(function* () {
          const request = Request.get("/x?a=1").pipe(Request.query(AOrB));
          const error = yield* refusal(request, { query: { b: "secret" } });
          expect(lostFrom(error.message)).toEqual(["b"]);
          expect(error.message).toContain("query group");
          expect(`${error.message} ${String(error)}`).not.toContain("secret");
          expect(JSON.stringify(error)).not.toContain("secret");
          expect(yield* urlOf(request, { query: { a: "2" } })).toBe("/x?a=2");
        }),
      );

      it.effect("names a header in the spelling the schema wrote it", () =>
        Effect.gen(function* () {
          const Spelled = Schema.Union([
            Schema.Struct({ "X-A": Schema.String }),
            Schema.Struct({ "X-B": Schema.String }),
          ]);
          const error = yield* refusal(
            Request.get("/x").pipe(
              Request.setHeader("x-a", "1"),
              Request.headers(Spelled),
            ),
            { headers: { "X-B": "2" } },
          );
          expect(lostFrom(error.message)).toEqual(["X-B"]);
        }),
      );

      it.effect(
        "names the default when the union keeps the caller's field",
        () =>
          Effect.gen(function* () {
            const Reversed = Schema.Union([
              Schema.Struct({ cursor: Schema.String }),
              Schema.Struct({ page: Schema.String }),
            ]);
            const error = yield* refusal(
              Request.get("/x?page=1").pipe(Request.query(Reversed)),
              { query: { cursor: "c" } },
            );
            expect(lostFrom(error.message)).toEqual(["page"]);
            const ReversedHeaders = Schema.Union([
              Schema.Struct({ "x-cursor": Schema.String }),
              Schema.Struct({ "x-page": Schema.String }),
            ]);
            const header = yield* refusal(
              Request.get("/x").pipe(
                Request.setHeader("x-page", "1"),
                Request.headers(ReversedHeaders),
              ),
              { headers: { "x-cursor": "c" } },
            );
            expect(lostFrom(header.message)).toEqual(["x-page"]);
          }),
      );

      it.effect(
        "does not blame shared query defaults for a caller's cursor",
        () =>
          Effect.gen(function* () {
            const one = Request.get("/x?page=1").pipe(Request.query(Paged));
            const two = Request.get("/x?page=1&size=9").pipe(
              Request.query(Paged),
            );
            for (const request of [one, two]) {
              const error = yield* refusal(request, {
                query: { cursor: "c" },
              });
              expect(lostFrom(error.message)).toEqual(["cursor"]);
              expect(error.message).not.toContain('"page"');
              expect(error.message).not.toContain('"size"');
            }
            // A caller on the default's own member is unaffected.
            expect(yield* urlOf(one, { query: { page: "2" } })).toBe(
              "/x?page=2",
            );
            expect(yield* urlOf(one, { query: { page: "2", size: "5" } })).toBe(
              "/x?page=2&size=5",
            );
            expect(yield* urlOf(two, { query: { page: "2" } })).toBe(
              "/x?page=2&size=9",
            );
            // A variant without the default takes the other member.
            const scrolling = one.pipe(Request.removeQuery("page"));
            expect(yield* urlOf(scrolling, { query: { cursor: "c" } })).toBe(
              "/x?cursor=c",
            );
          }),
      );

      it.effect(
        "does not blame shared header defaults for a caller's cursor",
        () =>
          Effect.gen(function* () {
            const request = Request.get("/x").pipe(
              Request.setHeader("x-page", "1"),
              Request.setHeader("x-size", "9"),
              Request.headers(PagedHeaders),
            );
            const error = yield* refusal(request, {
              headers: { "x-cursor": "c" },
            });
            expect(lostFrom(error.message)).toEqual(["x-cursor"]);
            const compiled = yield* compile(request, {
              headers: { "x-page": "2" },
            });
            expect(compiled.headerLines).toEqual([
              ["x-page", "2"],
              ["x-size", "9"],
            ]);
          }),
      );

      it.effect("names a default the caller's member cannot hold", () =>
        Effect.gen(function* () {
          const error = yield* refusal(
            Request.get("/x?size=9").pipe(Request.query(Paged)),
            { query: { cursor: "c" } },
          );
          expect(lostFrom(error.message)).toEqual(["size"]);
          const header = yield* refusal(
            Request.get("/x").pipe(
              Request.setHeader("x-size", "9"),
              Request.headers(PagedHeaders),
            ),
            { headers: { "x-cursor": "c" } },
          );
          expect(lostFrom(header.message)).toEqual(["x-size"]);
        }),
      );

      it.effect("names every field that would go, and only those", () =>
        Effect.gen(function* () {
          const Wide = Schema.Union([
            Schema.Struct({ a: Schema.String, b: Schema.String }),
            Schema.Struct({ c: Schema.String, d: Schema.String }),
          ]);
          const error = yield* refusal(
            Request.get("/x?a=1&b=2").pipe(Request.query(Wide)),
            { query: { c: "3", d: "4" } },
          );
          expect(lostFrom(error.message)).toEqual(["c", "d"]);
        }),
      );

      it.effect("takes a later member that holds the whole group", () =>
        Effect.gen(function* () {
          const Later = Schema.Union([
            Schema.Struct({ a: Schema.String }),
            Schema.Struct({
              a: Schema.optional(Schema.String),
              b: Schema.String,
            }),
          ]);
          expect(
            yield* urlOf(Request.get("/x?a=1").pipe(Request.query(Later)), {
              query: { b: "2" },
            }),
          ).toBe("/x?a=1&b=2");
          const Overlap = Schema.Union([
            Schema.Struct({ a: Schema.String }),
            Schema.Struct({ a: Schema.String, b: Schema.String }),
          ]);
          expect(
            yield* urlOf(Request.get("/x?b=1").pipe(Request.query(Overlap)), {
              query: { a: "x" },
            }),
          ).toBe("/x?a=x&b=1");
          const LaterHeaders = Schema.Union([
            Schema.Struct({ "x-a": Schema.String }),
            Schema.Struct({
              "x-a": Schema.optional(Schema.String),
              "x-b": Schema.String,
            }),
          ]);
          const compiled = yield* compile(
            Request.get("/x").pipe(
              Request.setHeader("x-a", "1"),
              Request.headers(LaterHeaders),
            ),
            { headers: { "x-b": "2" } },
          );
          expect(compiled.headerLines).toEqual([
            ["x-a", "1"],
            ["x-b", "2"],
          ]);
        }),
      );

      it.effect("is decided per call, not when the request is defined", () =>
        Effect.gen(function* () {
          const request = Request.get("/x?a=1").pipe(Request.query(AOrB));
          expect(yield* urlOf(request, { query: { a: "2" } })).toBe("/x?a=2");
          yield* refusal(request, { query: { b: "2" } });
          expect(yield* urlOf(request, { query: { a: "3" } })).toBe("/x?a=3");
        }),
      );

      it.effect("leaves a union alone when there is no default", () =>
        Effect.gen(function* () {
          const request = Request.get("/x").pipe(Request.query(AOrB));
          expect(yield* urlOf(request, { query: { b: "2" } })).toBe("/x?b=2");
        }),
      );

      it.effect("still takes a default that fits a discriminated union", () =>
        Effect.gen(function* () {
          const Tagged = Schema.Union([
            Schema.Struct({
              kind: Schema.Literal("a"),
              a: Schema.optional(Schema.String),
            }),
            Schema.Struct({
              kind: Schema.Literal("b"),
              b: Schema.optional(Schema.String),
            }),
          ]);
          const request = Request.get("/x?b=1").pipe(Request.query(Tagged));
          expect(yield* urlOf(request, { query: { kind: "b" } })).toBe(
            "/x?kind=b&b=1",
          );
          const error = yield* refusal(request, { query: { kind: "a" } });
          expect(lostFrom(error.message)).toEqual(["b"]);
        }),
      );

      it.effect("applies to a list of pairs and an open member too", () =>
        Effect.gen(function* () {
          const Pairs = Schema.Array(
            Schema.Tuple([Schema.String, Schema.String]),
          );
          expect(
            yield* urlOf(Request.get("/x?b=1").pipe(Request.query(Pairs)), {
              query: [["a", "2"]],
            }),
          ).toBe("/x?a=2&b=1");
          const Open = Schema.Union([
            Schema.Struct({ a: Schema.String }),
            Schema.Record(Schema.String, Schema.String),
          ]);
          expect(
            yield* urlOf(Request.get("/x?a=1").pipe(Request.query(Open)), {
              query: { b: "2" },
            }),
          ).toBe("/x?b=2&a=1");
        }),
      );
    });

    it.effect("is decoded with the rest of the group", () =>
      Effect.gen(function* () {
        const Range = Schema.Struct({
          from: Schema.FiniteFromString,
          to: Schema.optional(Schema.FiniteFromString),
        }).check(
          Schema.makeFilter(({ from, to }) =>
            to === undefined || from <= to ? undefined : "from comes after to",
          ),
        );
        const request = Request.get("/range?to=5").pipe(Request.query(Range));
        expect(yield* urlOf(request, { query: { from: 1 } })).toBe(
          "/range?from=1&to=5",
        );
        const error = yield* refusal(request, { query: { from: 9 } });
        expect(error.message).toContain('"to"');
      }),
    );

    it.effect(
      "is as strict as the schema, so a weak one lets text through",
      () =>
        Effect.gen(function* () {
          const request = Request.get("/things?limit=two").pipe(
            Request.query(
              Schema.Struct({
                limit: Schema.optional(Schema.NumberFromString),
              }),
            ),
          );
          expect(yield* urlOf(request, { query: {} })).toBe(
            "/things?limit=NaN",
          );
        }),
    );

    it.effect("needs the schema's decoding services", () =>
      Effect.gen(function* () {
        const Tenanted = Schema.String.pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transformEffect({
              decode: (wire: string) =>
                Effect.gen(function* () {
                  return `${yield* Tenant}:${wire}`;
                }),
              encode: (value: string) => Effect.succeed(value),
            }),
          ),
        );
        const request = Request.get("/things?who=me").pipe(
          Request.query(Schema.Struct({ who: Schema.optional(Tenanted) })),
        );
        type Needs = Effect.Services<ReturnType<typeof request.prepare>>;
        expectTypeOf<Needs>().toEqualTypeOf<Tenant>();
        expect(
          yield* urlOf(request, { query: {} }).pipe(
            Effect.provideService(Tenant, "t1"),
          ),
        ).toBe("/things?who=t1%3Ame");
      }),
    );

    it.effect.each([
      ["a number", Schema.Number, "5", "5"],
      ["a negative number", Schema.Number, "-1.5", "-1.5"],
      ["NaN", Schema.Number, "NaN", "NaN"],
      ["infinity", Schema.Number, "Infinity", "Infinity"],
      ["true", Schema.Boolean, "true", "true"],
      ["false", Schema.Boolean, "false", "false"],
      ["a bigint", Schema.BigInt, "90071992547409931", "90071992547409931"],
      ["a literal number", Schema.Literal(25), "25", "25"],
      ["a literal boolean", Schema.Literal(true), "true", "true"],
      ["a choice of numbers", Schema.Literals([10, 25]), "25", "25"],
      ["a number or null", Schema.NullOr(Schema.Number), "5", "5"],
      [
        "a number or a word",
        Schema.Union([Schema.Number, Schema.Literal("all")]),
        "all",
        "all",
      ],
      [
        "a number or a boolean",
        Schema.Union([Schema.Number, Schema.Boolean]),
        "true",
        "true",
      ],
      ["a list of numbers", Schema.Array(Schema.Number), "5", "5"],
    ] as const)("reads text as %s", ([, field, text, expected]) =>
      Effect.gen(function* () {
        const request = Request.get(`/things?a=${text}`).pipe(
          Request.query(Schema.Struct({ a: Schema.optional(field) })),
        );
        expect(yield* urlOf(request, { query: {} })).toBe(
          `/things?a=${expected}`,
        );
      }),
    );

    it.effect.each([
      ["a number", Schema.Number, "many"],
      ["a number, from nothing", Schema.Number, ""],
      ["a boolean", Schema.Boolean, "yes"],
      ["a bigint", Schema.BigInt, "1.5"],
      ["a literal number", Schema.Literal(25), "26"],
    ] as const)("refuses text that is not %s", ([, field, text]) =>
      Effect.gen(function* () {
        const request = Request.get(`/things?a=${text}`).pipe(
          Request.query(Schema.Struct({ a: Schema.optional(field) })),
        );
        const error = yield* refusal(request, { query: {} });
        expect(error.message).toContain('"a"');
      }),
    );

    it.effect(
      "reads text for a schema of its own that encodes to a number",
      () =>
        Effect.gen(function* () {
          const Slot = Schema.Struct({ at: Schema.optional(MomentFromNumber) });
          expect(
            yield* urlOf(
              Request.get("/slots?at=930").pipe(Request.query(Slot)),
              { query: {} },
            ),
          ).toBe("/slots?at=930");
          const error = yield* refusal(
            Request.get("/slots?at=-1").pipe(Request.query(Slot)),
            { query: {} },
          );
          expect(error.message).toContain('"at"');
        }),
    );

    it.effect("keeps a bare key for a field that holds null", () =>
      Effect.gen(function* () {
        const Flag = Schema.Struct({ wsdl: Schema.optional(Schema.Null) });
        expect(
          yield* urlOf(Request.get("/svc?wsdl").pipe(Request.query(Flag)), {
            query: {},
          }),
        ).toBe("/svc?wsdl");
        const refused = yield* refusal(
          Request.get("/svc?wsdl=1").pipe(Request.query(Flag)),
          { query: {} },
        );
        expect(refused.message).toContain('"wsdl"');
      }),
    );

    it.effect("takes one value or several under a list field", () =>
      Effect.gen(function* () {
        const Tags = Schema.Struct({
          tag: Schema.optional(Schema.Array(Schema.String)),
        });
        const one = Request.get("/x?tag=a").pipe(Request.query(Tags));
        expect(yield* urlOf(one, { query: {} })).toBe("/x?tag=a");
        const two = Request.get("/x?tag=a&tag=b").pipe(Request.query(Tags));
        expect(yield* urlOf(two, { query: {} })).toBe("/x?tag=a&tag=b");
        const lines = yield* linesOf(
          Request.get("/x").pipe(
            Request.appendHeader("X-Tag", "a"),
            Request.appendHeader("x-tag", "b"),
            Request.headers(
              Schema.Struct({
                "x-TAG": Schema.optional(Schema.Array(Schema.String)),
              }),
            ),
          ),
          { headers: {} },
        );
        expect(lines).toEqual([
          ["x-TAG", "a"],
          ["x-TAG", "b"],
        ]);
      }),
    );

    it.effect("refuses several values under a single field", () =>
      Effect.gen(function* () {
        const request = Request.get("/x?limit=1&limit=2").pipe(
          Request.query(Limit),
        );
        const error = yield* refusal(request, { query: {} });
        expect(error.message).toContain('"limit"');
      }),
    );
  });

  describe("a raw value under a name no schema allows", () => {
    const Etag = Schema.Struct({ "If-Match": Schema.String });

    it.effect("is an incompatible shape, in either order", () =>
      Effect.gen(function* () {
        const typed = Request.headers(Etag);
        const input = { headers: { "If-Match": "*" } };
        for (const request of [
          Request.put("/things").pipe(shared, typed),
          Request.put("/things").pipe(typed, shared),
        ]) {
          const error = yield* refusal(request, input);
          expect(error.message).toContain('"Authorization"');
          expect(error.message).toContain('Request.unbind("headers")');
          expect(error.message).not.toContain("Bearer shared");
        }
      }),
    );

    it.effect("is refused whatever the input, before any encoding", () =>
      Effect.gen(function* () {
        let encoded = 0;
        const Counted = Schema.String.pipe(
          Schema.decodeTo(
            Schema.String,
            SchemaTransformation.transform({
              decode: (wire: string) => wire,
              encode: (value: string) => {
                encoded++;
                return value;
              },
            }),
          ),
        );
        const error = yield* refusal(
          Request.get("/things?stray=1").pipe(
            Request.query(Schema.Struct({ q: Counted })),
          ),
          { query: { q: "x" } },
        );
        expect(error.message).toContain('"stray"');
        expect(encoded).toBe(0);
      }),
    );

    it.effect("names every field of both groups in one message", () =>
      Effect.gen(function* () {
        const error = yield* refusal(
          Request.get("/things?a=1&b=2&a=3").pipe(
            Request.setHeader("X-One", "1"),
            Request.query(Limit),
            Request.headers(Etag),
          ),
          { query: {}, headers: { "If-Match": "*" } },
        );
        expect(error.message).toContain('"a", "b"');
        expect(error.message).toContain('"X-One"');
      }),
    );

    it.effect("covers what is written in the constructor", () =>
      Effect.gen(function* () {
        const raw = Request.get("/things?page=1&limit=25");
        const Cursor = Schema.Struct({ cursor: Schema.String });
        const error = yield* refusal(raw.pipe(Request.query(Cursor)), {
          query: { cursor: "c" },
        });
        expect(error.message).toContain('"page", "limit"');
        // Typing part of a raw group takes the schema allowing the rest, or their removal.
        expect(
          yield* urlOf(
            raw.pipe(
              Request.removeQuery("page"),
              Request.removeQuery("limit"),
              Request.query(Cursor),
            ),
            { query: { cursor: "c" } },
          ),
        ).toBe("/things?cursor=c");
      }),
    );

    it.effect(
      "leaves a written empty segment behind the entries a schema covers",
      () =>
        Effect.gen(function* () {
          const Both = Schema.Struct({
            page: Schema.optional(Schema.FiniteFromString),
            tail: Schema.optional(Schema.String),
          });
          expect(
            yield* urlOf(
              Request.get("/things?page=02&&tail=1").pipe(Request.query(Both)),
              { query: {} },
            ),
          ).toBe("/things?&page=2&tail=1");
          expect(
            yield* urlOf(
              Request.get("/things?page=02&&&tail=1").pipe(Request.query(Both)),
              { query: {} },
            ),
          ).toBe("/things?&&page=2&tail=1");
        }),
    );

    it.effect(
      "leaves a written empty segment alone, because it names no field",
      () =>
        Effect.gen(function* () {
          expect(
            yield* urlOf(Request.get("/things?&&").pipe(Request.query(Limit)), {
              query: {},
            }),
          ).toBe("/things?&&");
          const open = Request.get("/things?a=1&").pipe(
            Request.query(Schema.Record(Schema.String, Schema.String)),
          );
          expect(yield* urlOf(open, { query: {} })).toContain("a=1");
        }),
    );

    it.effect("still counts an empty name that was written with a value", () =>
      Effect.gen(function* () {
        const error = yield* refusal(
          Request.get("/things?=1").pipe(Request.query(Limit)),
          { query: {} },
        );
        expect(error.message).toContain('""');
      }),
    );

    it.effect("does not count a computed value that declares nothing", () =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          Request.setQuery("stray", () => undefined),
          Request.query(Limit),
        );
        expect(yield* urlOf(request, { query: {} })).toBe("/things");
      }),
    );

    it.effect("compares header names without case", () =>
      Effect.gen(function* () {
        const request = Request.put("/things").pipe(
          Request.setHeader("if-MATCH", "raw"),
          Request.headers(
            Schema.Struct({ "If-Match": Schema.optional(Schema.String) }),
          ),
        );
        expect(yield* linesOf(request, { headers: {} })).toEqual([
          ["If-Match", "raw"],
        ]);
      }),
    );

    it.effect("compares query names with case", () =>
      Effect.gen(function* () {
        const error = yield* refusal(
          Request.get("/things?LIMIT=5").pipe(Request.query(Limit)),
          { query: {} },
        );
        expect(error.message).toContain('"LIMIT"');
      }),
    );

    it.effect("leaves text in the URL alone, as that is not a field", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/things").pipe(
              Request.baseUrl("https://api.test/v1?key=abc"),
              Request.query(Limit),
            ),
            { query: { limit: 5 } },
          ),
        ).toBe("https://api.test/v1?key=abc/things&limit=5");
        expect(
          yield* urlOf(
            Request.get("").pipe(
              Request.path(Schema.String, (id) => `/things?id=${id}`),
              Request.query(Limit),
            ),
            { path: "7", query: {} },
          ),
        ).toBe("/things?id=7");
      }),
    );
  });

  describe("a raw edit of a required field", () => {
    const Paged = Schema.Struct({
      page: Schema.FiniteFromString,
      limit: Schema.optional(Schema.FiniteFromString),
    });
    const typed = Request.get("/things").pipe(Request.query(Paged));
    const input = { query: { page: 1 } };

    it.effect.each([
      ["setQuery", Request.setQuery("page", "2")],
      ["appendQuery", Request.appendQuery("page", "2")],
      ["removeQuery", Request.removeQuery("page")],
      ["removeQuery with a value", Request.removeQuery("page", "2")],
    ] as const)("is refused from %s, after the schema", ([, edit]) =>
      Effect.gen(function* () {
        const error = yield* refusal(typed.pipe(edit), input);
        expect(error.message).toContain('"page"');
        expect(error.message).toContain("could never reach the client");
        expect(error.message).toContain('Request.unbind("query")');
      }),
    );

    it.effect.each([
      ["setHeader", Request.setHeader("X-LIMIT", "1")],
      ["appendHeader", Request.appendHeader("x-limit", "1")],
      ["removeHeader", Request.removeHeader("X-Limit")],
    ] as const)("is refused from %s, after the schema", ([, edit]) =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          Request.headers(Schema.Struct({ "x-limit": Schema.String })),
          edit,
        );
        const error = yield* refusal(request, {
          headers: { "x-limit": "2" },
        });
        expect(error.message).toContain("could never reach the client");
        expect(error.message).toContain('Request.unbind("headers")');
      }),
    );

    it.effect("is allowed for an optional field, and still checked", () =>
      Effect.gen(function* () {
        const set = typed.pipe(Request.setQuery("limit", "5"));
        expect(yield* urlOf(set, input)).toBe("/things?page=1&limit=5");
        expect(yield* urlOf(set, { query: { page: 1, limit: 9 } })).toBe(
          "/things?page=1&limit=9",
        );
        const error = yield* refusal(
          typed.pipe(Request.setQuery("limit", "many")),
          input,
        );
        expect(error.message).toContain('"limit"');
      }),
    );

    it.effect("clears the default of an optional field on removal", () =>
      Effect.gen(function* () {
        const defaulted = typed.pipe(Request.setQuery("limit", "25"));
        expect(
          yield* urlOf(defaulted.pipe(Request.removeQuery("limit")), input),
        ).toBe("/things?page=1");
      }),
    );

    it.effect("is not caught for a field the schema may leave out", () =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          Request.query(
            Schema.Struct({ a: Schema.UndefinedOr(Schema.String) }),
          ),
          Request.setQuery("a", "default"),
        );
        expect(yield* urlOf(request, { query: { a: undefined } })).toBe(
          "/things?a=default",
        );
      }),
    );

    it.effect("covers a required field with a default in its schema", () =>
      Effect.gen(function* () {
        const Defaulted = Schema.Struct({
          limit: Schema.FiniteFromString.pipe(
            Schema.withConstructorDefault(Effect.succeed(25)),
          ),
        });
        const request = Request.get("/things").pipe(Request.query(Defaulted));
        const error = yield* refusal(
          request.pipe(Request.removeQuery("limit")),
          { query: { limit: 5 } },
        );
        expect(error.message).toContain('"limit"');
      }),
    );

    it.effect("is refused for a class's field", () =>
      Effect.gen(function* () {
        class Filter extends Schema.Class<Filter>("Filter")({
          page: Schema.FiniteFromString,
        }) {}
        const error = yield* refusal(
          Request.get("/things").pipe(
            Request.query(Filter),
            Request.setQuery("page", "1"),
          ),
          { query: new Filter({ page: 1 }) },
        );
        expect(error.message).toContain("could never reach the client");
      }),
    );

    it.effect("is a problem of the group, so an unbind lifts it", () =>
      Effect.gen(function* () {
        const lifted = typed.pipe(
          Request.setQuery("page", "abc"),
          Request.unbind("query"),
        );
        expect(yield* urlOf(lifted, undefined)).toBe("/things?page=abc");
      }),
    );

    // https://github.com/viell-dev/slop-effect-schema-http/issues/120
    describe("under a field with a decoding default", () => {
      const twentyFive = Effect.succeed("25");
      const Limited = Schema.Struct({
        limit: Schema.FiniteFromString.pipe(
          Schema.withDecodingDefaultKey(twentyFive),
        ),
      });
      const limited = Request.get("/things").pipe(Request.query(Limited));

      it.effect("is refused, because the schema always writes it", () =>
        Effect.gen(function* () {
          const set = limited.pipe(Request.setQuery("limit", "5"));
          for (const query of [{ limit: 1 }, { limit: "1" }, {}]) {
            const error = yield* refusal(set, { query });
            expect(error.message).toContain("could never reach the client");
            expect(error.message).toContain('"limit"');
            expect(error.message).not.toContain("5");
          }
        }),
      );

      it.effect("is refused for every way of editing the group", () =>
        Effect.gen(function* () {
          for (const edit of [
            Request.setQuery({ limit: 5 }),
            Request.appendQuery("limit", "5"),
            Request.removeQuery("limit"),
            Request.removeQuery("limit", "5"),
          ]) {
            const error = yield* refusal(limited.pipe(edit), { query: {} });
            expect(error.message).toContain('"limit"');
          }
          const Header = Schema.Struct({
            "x-limit": Schema.String.pipe(
              Schema.withDecodingDefaultKey(twentyFive),
            ),
          });
          const headers = Request.get("/x").pipe(Request.headers(Header));
          for (const edit of [
            Request.setHeader("X-Limit", "5"),
            Request.setHeader({ "x-limit": "5" }),
            Request.appendHeader("x-limit", "5"),
            Request.removeHeader("x-limit"),
          ]) {
            const error = yield* refusal(headers.pipe(edit), { headers: {} });
            expect(error.message.toLowerCase()).toContain('"x-limit"');
            expect(error.message).toContain("headers group");
          }
        }),
      );

      it.effect("is refused under each form of decoding default", () =>
        Effect.gen(function* () {
          const text = Effect.succeed("25");
          for (const field of [
            Schema.String.pipe(Schema.withDecodingDefaultKey(text)),
            Schema.String.pipe(Schema.withDecodingDefault(text)),
            Schema.String.pipe(Schema.withDecodingDefaultTypeKey(text)),
            Schema.String.pipe(Schema.withDecodingDefaultType(text)),
          ]) {
            const error = yield* refusal(
              Request.get("/x").pipe(
                Request.query(Schema.Struct({ limit: field })),
                Request.setQuery("limit", "5"),
              ),
              { query: {} },
            );
            expect(error.message).toContain("could never reach the client");
          }
        }),
      );

      it.effect("is refused for a class's field", () =>
        Effect.gen(function* () {
          class Capped extends Schema.Class<Capped>("Capped")({
            limit: Schema.String.pipe(
              Schema.withDecodingDefaultKey(twentyFive),
            ),
          }) {}
          const error = yield* refusal(
            Request.get("/x").pipe(
              Request.query(Capped),
              Request.setQuery("limit", "5"),
            ),
            { query: new Capped({ limit: "1" }) },
          );
          expect(error.message).toContain("could never reach the client");
        }),
      );

      it.effect("is refused only if every union member writes the name", () =>
        Effect.gen(function* () {
          const defaulted = Schema.String.pipe(
            Schema.withDecodingDefaultKey(twentyFive),
          );
          const Every = Schema.Union([
            Schema.Struct({ a: Schema.String, limit: defaulted }),
            Schema.Struct({ b: Schema.String, limit: Schema.String }),
          ]);
          const every = yield* refusal(
            Request.get("/x").pipe(
              Request.query(Every),
              Request.setQuery("limit", "5"),
            ),
            { query: { a: "x" } },
          );
          expect(every.message).toContain("could never reach the client");
          const Some = Schema.Union([
            Schema.Struct({ a: Schema.String, limit: defaulted }),
            Schema.Struct({
              b: Schema.String,
              limit: Schema.optionalKey(Schema.String),
            }),
          ]);
          expect(
            yield* urlOf(
              Request.get("/x").pipe(
                Request.query(Some),
                Request.setQuery("limit", "5"),
              ),
              { query: { b: "x" } },
            ),
          ).toBe("/x?b=x&limit=5");
        }),
      );

      it.effect("stays a default before the schema", () =>
        Effect.gen(function* () {
          const before = Request.get("/things?limit=5").pipe(
            Request.query(Limited),
          );
          expect(yield* urlOf(before, { query: {} })).toBe("/things?limit=25");
          expect(yield* urlOf(before, { query: { limit: 1 } })).toBe(
            "/things?limit=1",
          );
        }),
      );

      it.effect("is lifted by an unbind", () =>
        Effect.gen(function* () {
          expect(
            yield* urlOf(
              limited.pipe(
                Request.setQuery("limit", "5"),
                Request.unbind("query"),
              ),
              undefined,
            ),
          ).toBe("/things?limit=5");
        }),
      );

      it.effect("is not refused where the schema may write nothing", () =>
        Effect.gen(function* () {
          const Maybe = Schema.Struct({
            limit: Schema.OptionFromOptionalKey(Schema.String),
          });
          const maybe = Request.get("/x").pipe(
            Request.query(Maybe),
            Request.setQuery("limit", "5"),
          );
          expect(yield* urlOf(maybe, { query: { limit: Option.none() } })).toBe(
            "/x?limit=5",
          );
          const Sometimes = Schema.Struct({
            limit: Schema.UndefinedOr(Schema.String).pipe(
              Schema.withDecodingDefaultKey(twentyFive),
            ),
          });
          expect(
            yield* urlOf(
              Request.get("/x").pipe(
                Request.query(Sometimes),
                Request.setQuery("limit", "5"),
              ),
              { query: { limit: undefined } },
            ),
          ).toBe("/x?limit=5");
          // Optional on the decoded side too, so a caller's `{}` is built with no such field.
          for (const limit of [
            Schema.String.pipe(
              Schema.optional,
              Schema.withDecodingDefault(twentyFive),
            ),
            Schema.String.pipe(
              Schema.optionalKey,
              Schema.withDecodingDefaultKey(twentyFive),
            ),
          ])
            expect(
              yield* urlOf(
                Request.get("/x").pipe(
                  Request.query(Schema.Struct({ limit })),
                  Request.setQuery("limit", "5"),
                ),
                { query: {} },
              ),
            ).toBe("/x?limit=5");
        }),
      );

      it.effect("is not this refusal under the omit strategy", () =>
        Effect.gen(function* () {
          const Omitted = Schema.Struct({
            limit: Schema.String.pipe(
              Schema.withDecodingDefaultKey(twentyFive, {
                encodingStrategy: "omit",
              }),
            ),
          });
          // The schema reads the name and never writes it, so the value goes either way.
          const error = yield* refusal(
            Request.get("/x").pipe(
              Request.query(Omitted),
              Request.setQuery("limit", "5"),
            ),
            { query: {} },
          );
          expect(error.message).toContain("would be lost");
          expect(error.message).not.toContain("could never reach the client");
        }),
      );

      // https://github.com/viell-dev/slop-effect-schema-http/issues/143
      it.effect(
        "refuses a replaced edit for an empty group that a struct renames",
        () =>
          Effect.gen(function* () {
            const Renamed = Limited.pipe(
              Schema.encodeKeys({ limit: "page_size" }),
            );
            expect(
              (yield* refusal(
                Request.get("/x").pipe(
                  Request.query(Renamed),
                  Request.setQuery("page_size", "5"),
                ),
                { query: {} },
              )).message,
            ).toContain('"page_size"');
          }),
      );

      // Construction and encoding supply the omitted field, so this later edit would be lost.
      // https://github.com/viell-dev/slop-effect-schema-http/issues/143
      it.effect(
        "refuses an edit replaced by a constructor-filled optional field",
        () =>
          Effect.gen(function* () {
            const Defaulted = Schema.Struct({
              limit: Schema.optionalKey(Schema.String).pipe(
                Schema.withConstructorDefault(twentyFive),
              ),
            });
            expect(
              (yield* refusal(
                Request.get("/x").pipe(
                  Request.query(Defaulted),
                  Request.setQuery("limit", "5"),
                ),
                { query: {} },
              )).message,
            ).toContain('"limit"');
          }),
      );
    });

    it.effect("is told apart from a field no schema allows", () =>
      Effect.gen(function* () {
        const error = yield* refusal(
          typed.pipe(
            Request.setQuery("page", "2"),
            Request.setQuery("fields", "id"),
          ),
          input,
        );
        expect(error.message).toContain("could never reach the client");
        expect(error.message).toContain('"fields"');
      }),
    );
  });

  describe("schemas stack", () => {
    const Paging = Schema.Struct({
      page: Schema.optional(Schema.FiniteFromString),
    });
    const Sorting = Schema.Struct({ sort: Schema.optional(Schema.String) });
    const paged = Request.query(Paging);
    const sorted = Request.query(Sorting);

    it.effect("each adds its fields, and together they state the shape", () =>
      Effect.gen(function* () {
        const request = Request.get("/things?sort=name&page=2").pipe(
          paged,
          sorted,
        );
        expect(yield* urlOf(request, { query: {} })).toBe(
          "/things?page=2&sort=name",
        );
        expect(yield* urlOf(request, { query: { page: 3, sort: "age" } })).toBe(
          "/things?page=3&sort=age",
        );
      }),
    );

    it.effect("each takes its own fields from one input", () =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          Request.query(Schema.Struct({ a: Schema.String })),
          Request.query(Schema.Struct({ b: Schema.NumberFromString })),
        );
        expect(yield* urlOf(request, { query: { a: "1", b: 2 } })).toBe(
          "/things?a=1&b=2",
        );
      }),
    );

    it.effect("work for headers", () =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          shared,
          Request.headers(Schema.Struct(Authorization)),
          Request.headers(Schema.Struct({ "X-Trace": Schema.String })),
        );
        expect(
          yield* linesOf(request, { headers: { "X-Trace": "t" } }),
        ).toEqual([
          ["Authorization", "Bearer shared"],
          ["X-Trace", "t"],
        ]);
      }),
    );

    it.effect("let a later schema allow what an earlier one does not", () =>
      Effect.gen(function* () {
        const halfway = Request.get("/things?sort=name").pipe(paged);
        const error = yield* refusal(halfway, { query: {} });
        expect(error.message).toContain('"sort"');
        expect(yield* urlOf(halfway.pipe(sorted), { query: {} })).toBe(
          "/things?sort=name",
        );
      }),
    );

    it.effect("widen a typed group in two steps", () =>
      Effect.gen(function* () {
        const typed = Request.get("/things").pipe(
          Request.query(Schema.Struct({ page: Schema.FiniteFromString })),
        );
        const widened = typed.pipe(
          Request.query(
            Schema.Struct({ fields: Schema.optional(Schema.String) }),
          ),
          Request.setQuery("fields", "id,name"),
        );
        expect(yield* urlOf(widened, { query: { page: 1 } })).toBe(
          "/things?page=1&fields=id%2Cname",
        );
      }),
    );

    it.effect(
      "show an open schema every field, so its values have to fit",
      () =>
        Effect.gen(function* () {
          const request = Request.get("/x").pipe(
            Request.query(Schema.Struct({ page: Schema.FiniteFromString })),
            Request.query(Schema.Record(Schema.String, Schema.String)),
          );
          expect(
            yield* urlOf(request, { query: { page: "2", extra: "x" } }),
          ).toBe("/x?page=2&extra=x");
          const refused = { query: { page: 2 } } as never;
          expect(yield* Effect.flip(compile(request, refused))).toBeInstanceOf(
            Schema.SchemaError,
          );
        }),
    );

    it.effect("send a default through every schema that allows its name", () =>
      Effect.gen(function* () {
        const Short = Schema.Struct({
          limit: Schema.optional(Schema.String.check(Schema.isMaxLength(2))),
        });
        const request = Request.get("/things?limit=123").pipe(
          Request.query(Limit),
          Request.query(Short),
        );
        const error = yield* refusal(request, { query: {} });
        expect(error.message).toContain('"limit"');
      }),
    );

    it.effect("keep a required field required under a later schema", () =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          Request.query(Schema.Struct({ page: Schema.FiniteFromString })),
          sorted,
          Request.setQuery("page", "2"),
        );
        const error = yield* refusal(request, { query: { page: 1 } });
        expect(error.message).toContain('"page"');
      }),
    );

    it.effect("share a constant for shared names", () =>
      Effect.gen(function* () {
        const ApiHeaders = { Authorization: Schema.optional(Schema.String) };
        const list = Request.get("https://api.test/things").pipe(
          Request.setHeader("Authorization", "Bearer token"),
          Request.setQuery("limit", "25"),
          Request.headers(
            Schema.Struct({ ...ApiHeaders, "x-trace": Schema.String }),
          ),
          Request.query(Limit),
          sorted,
        );
        const input = {
          headers: { "x-trace": "t" },
          query: { sort: "name" },
        };
        const compiled = yield* compile(list, input);
        expect(compiled.request.url).toBe(
          "https://api.test/things?limit=25&sort=name",
        );
        expect(compiled.headerLines).toEqual([
          ["Authorization", "Bearer token"],
          ["x-trace", "t"],
        ]);
        expect(
          yield* urlOf(list.pipe(Request.setQuery("limit", "5")), input),
        ).toBe("https://api.test/things?limit=5&sort=name");
        expect(
          yield* urlOf(list.pipe(Request.removeQuery("limit")), input),
        ).toBe("https://api.test/things?sort=name");
        const error = yield* refusal(
          list.pipe(Request.setQuery("fields", "id")),
          input,
        );
        expect(error.message).toContain('"fields"');
      }),
    );
  });

  describe("reading names from a schema", () => {
    it.effect(
      "uses wire names, so a renamed field goes by its encoded name",
      () =>
        Effect.gen(function* () {
          const Paging = Schema.Struct({
            page: Schema.optional(Schema.FiniteFromString),
          }).pipe(Schema.encodeKeys({ page: "page_number" }));
          expect(
            yield* urlOf(
              Request.get("/things?page_number=2").pipe(Request.query(Paging)),
              { query: {} },
            ),
          ).toBe("/things?page_number=2");
          const error = yield* refusal(
            Request.get("/things?page=2").pipe(Request.query(Paging)),
            { query: {} },
          );
          expect(error.message).toContain('"page"');
        }),
    );

    it.effect("reads a class's fields", () =>
      Effect.gen(function* () {
        class Filter extends Schema.Class<Filter>("Filter")({
          limit: Schema.optional(Schema.FiniteFromString),
        }) {}
        const allowed = Request.get("/things?limit=2").pipe(
          Request.query(Filter),
        );
        expect(yield* urlOf(allowed, { query: new Filter({}) })).toBe(
          "/things?limit=2",
        );
        const error = yield* refusal(
          Request.get("/things?other=2").pipe(Request.query(Filter)),
          { query: new Filter({}) },
        );
        expect(error.message).toContain('"other"');
      }),
    );

    it.effect("allows what any member of a union allows", () =>
      Effect.gen(function* () {
        const Either = Schema.Union([
          Schema.Struct({
            a: Schema.String,
            b: Schema.optional(Schema.String),
          }),
          Schema.Struct({
            a: Schema.String,
            c: Schema.optional(Schema.String),
          }),
        ]);
        const request = Request.get("/x?b=1").pipe(Request.query(Either));
        expect(yield* urlOf(request, { query: { a: "x" } })).toBe("/x?a=x&b=1");
        const error = yield* refusal(
          Request.get("/x?d=1").pipe(Request.query(Either)),
          { query: { a: "x" } },
        );
        expect(error.message).toContain('"d"');
        // Every member writes `a`, so it is required; `b` is not.
        const required = yield* refusal(
          Request.get("/x").pipe(
            Request.query(Either),
            Request.setQuery("a", "1"),
          ),
          { query: { a: "x" } },
        );
        expect(required.message).toContain("could never reach the client");
      }),
    );

    it.effect("does not require what only some members of a union write", () =>
      Effect.gen(function* () {
        const Some = Schema.Union([
          Schema.Struct({ a: Schema.String, b: Schema.String }),
          Schema.Struct({
            a: Schema.String,
            b: Schema.String,
            d: Schema.String,
          }),
          Schema.Struct({
            a: Schema.String,
            c: Schema.optional(Schema.String),
          }),
        ]);
        const request = Request.get("/x").pipe(
          Request.query(Some),
          Request.setQuery("b", "1"),
        );
        expect(yield* urlOf(request, { query: { a: "x" } })).toBe("/x?a=x&b=1");
      }),
    );

    it.effect("states literal record keys as names", () =>
      Effect.gen(function* () {
        const Named = Schema.Record(Schema.Literals(["a", "b"]), Schema.String);
        const error = yield* refusal(
          Request.get("/x?c=1").pipe(Request.query(Named)),
          { query: { a: "1", b: "2" } },
        );
        expect(error.message).toContain('"c"');
      }),
    );
  });

  describe("a schema that allows other names", () => {
    const Open = Schema.Record(Schema.String, Schema.String);

    it.effect("allows any name from a record, in either order", () =>
      Effect.gen(function* () {
        const request = Request.get("/x").pipe(
          Request.setQuery("a", "raw"),
          Request.query(Open),
          Request.setQuery("b", "raw"),
        );
        expect(yield* urlOf(request, { query: { a: "typed" } })).toBe(
          "/x?a=typed&b=raw",
        );
      }),
    );

    it.effect("still checks each value", () =>
      Effect.gen(function* () {
        const Short = Schema.Record(
          Schema.String,
          Schema.String.check(Schema.isMaxLength(2)),
        );
        const error = yield* refusal(
          Request.get("/x?a=123").pipe(Request.query(Short)),
          { query: {} },
        );
        expect(error.message).toContain('"a"');
      }),
    );

    it.effect("reads text and lists under a record's value type", () =>
      Effect.gen(function* () {
        const Counts = Schema.Record(Schema.String, Schema.Number);
        expect(
          yield* urlOf(Request.get("/x?a=5").pipe(Request.query(Counts)), {
            query: {},
          }),
        ).toBe("/x?a=5");
        const Lists = Schema.Record(Schema.String, Schema.Array(Schema.String));
        expect(
          yield* urlOf(Request.get("/x?a=5").pipe(Request.query(Lists)), {
            query: {},
          }),
        ).toBe("/x?a=5");
      }),
    );

    it.effect("allows any name from Schema.StructWithRest", () =>
      Effect.gen(function* () {
        const Rest = Schema.StructWithRest(
          Schema.Struct({ "If-Match": Schema.optional(Schema.String) }),
          [Open],
        );
        const request = Request.put("/x").pipe(
          shared,
          Request.setHeader("if-match", "raw"),
          Request.headers(Rest),
        );
        expect(
          yield* linesOf(request, { headers: { "X-Other": "1" } }),
        ).toEqual([
          ["If-Match", "raw"],
          ["X-Other", "1"],
          ["Authorization", "Bearer shared"],
        ]);
      }),
    );

    // Defaults are added as pairs, which only a list of pairs reads. #120 kept this, because it fails
    // before anything is sent. The design page states the limit.
    // https://github.com/viell-dev/slop-effect-schema-http/issues/120
    it.effect(
      "cannot take a default under a schema encoded as a Map, and says so before dispatch",
      () =>
        Effect.gen(function* () {
          const request = Request.get("/x?a=1").pipe(
            Request.query(Schema.ReadonlyMap(Schema.String, Schema.String)),
          );
          const input = { query: new Map([["b", "2"]]) };
          const error = yield* refusal(request, input);
          expect(error.message).toContain('"a"');
          expect(
            yield* urlOf(request.pipe(Request.removeQuery("a")), input),
          ).toBe("/x?b=2");
        }),
    );

    it.effect("allows any name from a list of pairs", () =>
      Effect.gen(function* () {
        const Pairs = Schema.Array(
          Schema.Tuple([Schema.String, Schema.String]),
        );
        const request = Request.get("/x?a=raw&b=raw").pipe(
          Request.query(Pairs),
        );
        expect(yield* urlOf(request, { query: [["a", "typed"]] })).toBe(
          "/x?a=typed&b=raw",
        );
      }),
    );

    it.effect("takes fields a plain object would inherit", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/x?constructor=1&toString=2&__proto__=3").pipe(
              Request.query(Open),
            ),
            { query: {} },
          ),
        ).toBe("/x?constructor=1&toString=2&__proto__=3");
        expect(
          yield* urlOf(
            Request.get("/x?constructor=1&constructor=2").pipe(
              Request.query(
                Schema.Record(Schema.String, Schema.Array(Schema.String)),
              ),
            ),
            { query: {} },
          ),
        ).toBe("/x?constructor=1&constructor=2");
      }),
    );
  });

  describe("outside the check", () => {
    const Trace = Schema.Struct({
      trace: Schema.optional(Schema.FiniteFromString),
    });

    it.effect("leaves a native query edit before the schema alone", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/x").pipe(appendTrace("many"), Request.query(Trace)),
            { query: {} },
          ),
        ).toBe("/x?trace=many");
        expect(
          yield* urlOf(
            Request.get("/x").pipe(
              appendTrace("many"),
              Request.query(Schema.Struct({ q: Schema.String })),
            ),
            { query: { q: "1" } },
          ),
        ).toBe("/x?trace=many&q=1");
      }),
    );

    it.effect("leaves a native query edit after the schema alone", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/x").pipe(Request.query(Trace), appendTrace("many")),
            { query: {} },
          ),
        ).toBe("/x?trace=many");
      }),
    );

    it.effect("leaves a native header edit alone", () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.get("/x").pipe(
            Request.mapEffect((request) =>
              Effect.succeed(
                HttpClientRequest.setHeader(request, "x-stray", "1"),
              ),
            ),
            Request.headers(Schema.Struct({ "X-Trace": Schema.String })),
          ),
          { headers: { "X-Trace": "t" } },
        );
        expect(compiled.request.headers["x-stray"]).toBe("1");
      }),
    );
  });

  describe("Request.unbind", () => {
    const Paging = Schema.Struct({ page: Schema.FiniteFromString });
    const typed = Request.get("/things").pipe(
      Request.setQuery("locale", "sv"),
      Request.query(Paging),
      Request.query(Schema.Struct({ locale: Schema.optional(Schema.String) })),
    );

    it.effect("removes the bindings, their input and the shape", () =>
      Effect.gen(function* () {
        const raw = typed.pipe(Request.unbind("query"));
        expectTypeOf(raw).toEqualTypeOf<
          Request.Request<unknown, Schema.SchemaError | Request.InvalidRequest>
        >();
        expect(yield* urlOf(raw, undefined)).toBe("/things?locale=sv");
        expect(
          yield* urlOf(raw.pipe(Request.setQuery("any", "name")), undefined),
        ).toBe("/things?locale=sv&any=name");
      }),
    );

    it.effect("replaces a binding when followed by a new one", () =>
      Effect.gen(function* () {
        const variant = typed.pipe(
          Request.unbind("query"),
          Request.removeQuery("locale"),
          Request.query(Schema.Struct({ sort: Schema.String })),
        );
        expect(yield* urlOf(variant, { query: { sort: "name" } })).toBe(
          "/things?sort=name",
        );
        void (() =>
          // @ts-expect-error: the earlier schema's input is gone
          compile(variant, { query: { page: 1 } }));
      }),
    );

    it.effect("leaves the request it was derived from unchanged", () =>
      Effect.gen(function* () {
        void typed.pipe(Request.unbind("query"));
        expect(yield* urlOf(typed, { query: { page: 1 } })).toBe(
          "/things?page=1&locale=sv",
        );
      }),
    );

    it.effect("clears headers, and leaves other groups' input in place", () =>
      Effect.gen(function* () {
        const request = Request.post("/things").pipe(
          Request.setHeader("X-Raw", "1"),
          Request.headers(
            Schema.Struct({ "X-Raw": Schema.optional(Schema.String) }),
          ),
          Request.body(Body.text),
          Request.unbind("headers"),
        );
        expectTypeOf<Parameters<typeof request.prepare>[0]>().toEqualTypeOf<
          Omit<
            { readonly headers: { readonly "X-Raw"?: string | undefined } } & {
              readonly body: string;
            },
            "headers"
          >
        >();
        const compiled = yield* compile(request, { body: "b" });
        expect(compiled.headerLines).toContainEqual(["X-Raw", "1"]);
        expect(bodyText(compiled.request)).toBe("b");
      }),
    );

    it.effect("clears a path binding, leaving the constructor's path", () =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          Request.path(Schema.String, (id) => `/other/${id}`),
          Request.unbind("path"),
        );
        expect(yield* urlOf(request, undefined)).toBe("/things");
      }),
    );

    it.effect("clears a body binding and its automatic fields", () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.post("/things").pipe(
            Request.body(Body.text),
            Request.unbind("body"),
          ),
          undefined,
        );
        expect(compiled.request.body._tag).toBe("Empty");
        expect(compiled.request.headers["content-type"]).toBeUndefined();
      }),
    );

    it.effect("replaces a body with another of a different type", () =>
      Effect.gen(function* () {
        const compiled = yield* compile(
          Request.post("/things").pipe(
            Request.body(Body.text),
            Request.unbind("body"),
            Request.body(Body.json),
          ),
          { body: { id: 1 } },
        );
        expect(bodyText(compiled.request)).toBe('{"id":1}');
        expect(compiled.request.headers["content-type"]).toBe(
          "application/json",
        );
      }),
    );

    it.effect("affects only the bindings before it", () =>
      Effect.gen(function* () {
        const request = Request.get("/things").pipe(
          Request.query(Paging),
          Request.unbind("query"),
          Request.query(Paging),
          Request.setQuery("stray", "1"),
        );
        const error = yield* refusal(request, { query: { page: 1 } });
        expect(error.message).toContain('"stray"');
      }),
    );

    it.effect("leaves a mapEffect that reads the removed input nothing", () =>
      Effect.gen(function* () {
        const seen: Array<unknown> = [];
        const noteQuery = Request.mapEffect(
          (native, input: { readonly query: unknown }) =>
            Effect.sync(() => {
              seen.push(input.query);
              return native;
            }),
        );
        const noted = Request.get("/things").pipe(
          Request.query(Paging),
          noteQuery,
        );
        yield* compile(
          noted.pipe(
            Request.headers(Schema.Struct({ "x-a": Schema.String })),
            Request.unbind("query"),
          ),
          { headers: { "x-a": "1" } },
        );
        expect(seen).toEqual([undefined]);

        const exit = yield* Effect.exit(
          compile(noted.pipe(Request.unbind("query")), undefined),
        );
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
      }),
    );

    it.effect(
      "skips a binding that mapInput feeds, keeping what it requires",
      () =>
        Effect.gen(function* () {
          const request = Request.get("/things").pipe(
            Request.query(Paging),
            Request.mapInput((input: { readonly page: number }) => ({
              query: { page: input.page },
            })),
            Request.unbind("query"),
          );
          expectTypeOf<Parameters<typeof request.prepare>[0]>().toEqualTypeOf<{
            readonly page: number;
          }>();
          expect(yield* urlOf(request, { page: 1 })).toBe("/things");
        }),
    );

    it("keeps an input it cannot reach", () => {
      const scalar = Request.get("/").pipe(
        Request.mapInput((input: number) => input),
        Request.unbind("query"),
      );
      expectTypeOf<
        Parameters<typeof scalar.prepare>[0]
      >().toEqualTypeOf<number>();
    });

    it("refuses anything that is not a group", () => {
      // @ts-expect-error: fragments are not a group
      void Request.unbind("fragment");
    });
  });

  describe("what a caller can pass", () => {
    // https://github.com/viell-dev/slop-effect-schema-http/issues/111
    it.effect("replaces a value a schema allows", () =>
      Effect.gen(function* () {
        const request = Request.get("/x").pipe(
          shared,
          Request.headers(Schema.Struct(Authorization)),
        );
        expect(
          yield* linesOf(request, {
            headers: { Authorization: "Bearer mine" },
          }),
        ).toEqual([["Authorization", "Bearer mine"]]);
      }),
    );

    it.effect("is limited by Request.mapInput, which fixes the value", () =>
      Effect.gen(function* () {
        const request = Request.get("/x").pipe(
          Request.headers(Schema.Struct({ Authorization: Schema.String })),
          Request.mapInput(() => ({
            headers: { Authorization: "Bearer shared" },
          })),
        );
        expect(yield* linesOf(request, undefined)).toEqual([
          ["Authorization", "Bearer shared"],
        ]);
      }),
    );
  });

  describe("types", () => {
    it("lets a generic helper accept any request", () => {
      const typed = withService(Request.get("/x").pipe(Request.query(Limit)));
      expectTypeOf(typed).toEqualTypeOf<
        Request.Request<
          { readonly query?: Request.Input<typeof Limit> },
          Schema.SchemaError | Request.InvalidRequest
        >
      >();
      expectTypeOf(withoutQuery(Request.get("/x"))).toEqualTypeOf<
        Request.Request<unknown>
      >();
    });

    it("lets a shared transform compose before or after a schema", () => {
      const localized = flow(
        Request.setQuery("locale", "sv"),
        Request.setHeader("X-Locale", "sv"),
      );
      void Request.get("/x").pipe(localized, Request.query(Limit));
      void Request.get("/x").pipe(Request.query(Limit), localized);
    });

    it("requires the input of every stacked schema", () => {
      const request = Request.get("/x").pipe(
        Request.query(Schema.Struct({ a: Schema.String })),
        Request.query(Schema.Struct({ b: Schema.String })),
      );
      void Request.compile(request, { query: { a: "1", b: "2" } });
      // @ts-expect-error: the second schema's field is missing
      void Request.compile(request, { query: { a: "1" } });
    });

    it("no longer takes the two binding parameters", () => {
      // @ts-expect-error: `Request` takes input, errors and services
      expectTypeOf<Request.Request<unknown, never, never, false, false>>();
    });
  });
});
