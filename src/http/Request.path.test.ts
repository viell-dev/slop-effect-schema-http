import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  flow,
  Option,
  Schema,
  SchemaTransformation,
} from "effect";
import { HttpClientRequest } from "effect/http";
import {
  compile,
  loneSurrogate,
  rendered,
  targetOf,
  Tenant,
  urlOf,
} from "../../test/request.js";
import * as Request from "./Request.js";
import * as UrlEncoding from "./UrlEncoding.js";

describe("Request.path", () => {
  const Id = Schema.String;

  it.effect("renders the schema-encoded value with the path encoder", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("").pipe(
            Request.path(Id, (id, encode) => `/files/${encode(id)}/meta`),
            Request.baseUrl("https://api.test"),
          ),
          { path: "a/b c" },
        ),
      ).toBe("https://api.test/files/a%2Fb%20c/meta");
    }),
  );

  it.effect("adds to the constructor's path and keeps its query", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("https://api.test/items?format=xml").pipe(
            Request.path(Id, (id, encode) => `/${encode(id)}`),
          ),
          { path: "7" },
        ),
      ).toBe("https://api.test/items/7?format=xml");
    }),
  );

  it.effect("passes encoded fields of a struct", () =>
    Effect.gen(function* () {
      const Key = Schema.Struct({
        org: Schema.String,
        n: Schema.NumberFromString,
      });
      expect(
        yield* urlOf(
          Request.get("").pipe(
            Request.path(
              Key,
              ({ org, n }, encode) => `/orgs/${encode(org)}/items/${encode(n)}`,
            ),
          ),
          { path: { org: "acme", n: 12 } },
        ),
      ).toBe("/orgs/acme/items/12");
    }),
  );

  it.effect("uses the current URL encoding service", () =>
    Effect.gen(function* () {
      const url = yield* urlOf(
        Request.get("").pipe(
          Request.path(Id, (id, encode) => `/raw/${encode(id)}`),
        ),
        { path: "a/b" },
      ).pipe(
        Effect.provide(
          UrlEncoding.layer({
            ...UrlEncoding.defaults,
            path: (value) => value,
          }),
        ),
      );
      expect(url).toBe("/raw/a/b");
    }),
  );

  it.effect(
    "joins query entries with '&' when the rendered URL already has a query",
    () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("https://api.test").pipe(
              Request.setQuery("b", "2"),
              Request.path(Id, (id) => `/x?a=${id}`),
            ),
            { path: "1" },
          ),
        ).toBe("https://api.test/x?a=1&b=2");
      }),
  );

  it("renders the schema's encoded value, not its application value", () => {
    Request.path(Schema.NumberFromString, (page: string, encode) =>
      encode(page),
    );
    // @ts-expect-error: render receives the encoded string
    Request.path(Schema.NumberFromString, (page: number) => String(page));
  });

  it.effect("leaves dot segments unencoded at the library boundary", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("").pipe(
            Request.path(
              Id,
              (id, encode) => `https://api.test/files/${encode(id)}`,
            ),
          ),
          { path: ".." },
        ),
      ).toBe("https://api.test/files/..");
    }),
  );

  const unencodable = Request.get("").pipe(
    Request.path(Id, (id, encode) => `https://api.test/files/${encode(id)}`),
  );

  // https://github.com/viell-dev/slop-effect-schema-http/issues/5
  it.effect(
    "fails with InvalidRequest when a path value cannot be percent-encoded",
    () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          compile(unencodable, { path: loneSurrogate }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) return;
        expect(Cause.hasDies(exit.cause)).toBe(false);
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
        expect(error).toBeInstanceOf(Request.InvalidRequest);
        expect(
          error instanceof Request.InvalidRequest ? error.cause : undefined,
        ).toBeInstanceOf(URIError);
      }),
  );

  it.effect(
    "fails with InvalidRequest when a replaced path encoder throws",
    () =>
      Effect.gen(function* () {
        const refused = new Error("segment refused");
        const error = yield* Effect.flip(
          compile(unencodable, { path: ".." }).pipe(
            Effect.provide(
              UrlEncoding.layer({
                ...UrlEncoding.defaults,
                path: () => {
                  throw refused;
                },
              }),
            ),
          ),
        );
        expect(error).toBeInstanceOf(Request.InvalidRequest);
        expect(
          error instanceof Request.InvalidRequest ? error.cause : undefined,
        ).toBe(refused);
      }),
  );

  it("adds InvalidRequest to the request's error type", () => {
    expectTypeOf<
      Effect.Error<ReturnType<typeof unencodable.prepare>>
    >().toEqualTypeOf<Schema.SchemaError | Request.InvalidRequest>();
  });
});

// https://github.com/viell-dev/slop-effect-schema-http/issues/82
describe("the path is joined exactly", () => {
  it.effect.each([
    ["/users", "/42", "/users/42"],
    ["", "/users/1", "/users/1"],
    ["https://api.test/v1", "/users/1", "https://api.test/v1/users/1"],
    ["/things/42", ":archive", "/things/42:archive"],
    ["/users/", "/42", "/users//42"],
    ["/users", "42", "/users42"],
    ["/things", ".json", "/things.json"],
    ["/fetch/", "https://other.test/x", "/fetch/https://other.test/x"],
  ] as const)("%s followed by %s", ([start, added, url]) =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(Request.get(start).pipe(rendered(added)), { path: "" }),
      ).toBe(url);
    }),
  );

  it.effect("follows the same rule for a template", () =>
    Effect.gen(function* () {
      const id = Request.pathValue("id");
      const input = { path: { id: "42" } };
      expect(
        yield* urlOf(Request.get("/users").pipe(Request.path`/${id}`), input),
      ).toBe("/users/42");
      expect(
        yield* urlOf(Request.get("/users").pipe(Request.path`${id}`), input),
      ).toBe("/users42");
      expect(
        yield* urlOf(Request.get("/users/").pipe(Request.path`/${id}`), input),
      ).toBe("/users//42");
      expect(
        yield* urlOf(
          Request.get("/things/42").pipe(Request.path`:archive`),
          undefined,
        ),
      ).toBe("/things/42:archive");
      expect(
        yield* urlOf(Request.get("").pipe(Request.path`/users/1`), undefined),
      ).toBe("/users/1");
    }),
  );

  it.effect("adds repeated calls in order, of either form", () =>
    Effect.gen(function* () {
      const id = Request.pathValue("id");
      const request = Request.get("/a").pipe(
        Request.path`/b`,
        Request.path(
          Schema.Struct({ section: Schema.String }),
          ({ section }, encode) => `/${encode(section)}`,
        ),
        Request.path`/c/${id}`,
        Request.path`/d`,
      );
      expect(yield* urlOf(request, { path: { section: "s t", id: "x" } })).toBe(
        "/a/b/s%20t/c/x/d",
      );
    }),
  );

  it.effect("no longer drops the constructor's path", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/users").pipe(
            Request.path(Schema.String, (id, encode) => `/users/${encode(id)}`),
          ),
          { path: "1" },
        ),
      ).toBe("/users/users/1");
    }),
  );

  it.effect("starts again on each evaluation", () =>
    Effect.gen(function* () {
      const request = Request.get("/a").pipe(Request.path`/b`);
      expect(yield* urlOf(request, undefined)).toBe("/a/b");
      expect(yield* urlOf(request, undefined)).toBe("/a/b");
    }),
  );

  it.effect("leaves the parent as it was", () =>
    Effect.gen(function* () {
      const parent = Request.get("/a");
      const child = parent.pipe(Request.path`/b`);
      expect(yield* urlOf(child.pipe(Request.path`/c`), undefined)).toBe(
        "/a/b/c",
      );
      expect(yield* urlOf(child, undefined)).toBe("/a/b");
      expect(yield* urlOf(parent, undefined)).toBe("/a");
    }),
  );

  it.effect("reads a # as a fragment for all that follows it", () =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(
          Request.get("/a").pipe(Request.path`/b#x`, Request.path`/c`),
          undefined,
        ),
      ).toEqual({ url: "/a/b", hash: "x/c" });
    }),
  );

  it.effect("leaves a ? in the text as URL text", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/a?wsdl").pipe(
            Request.path`/b?x=1`,
            Request.path`/c`,
            Request.setQuery("y", "2"),
          ),
          undefined,
        ),
      ).toBe("/a/b?x=1/c&wsdl&y=2");
    }),
  );

  it.effect("keeps the constructor's query, bare flags and fragment", () =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(
          Request.get("/x?wsdl&a=%41#top").pipe(Request.path`/y`),
          undefined,
        ),
      ).toEqual({ url: "/x/y?wsdl&a=%41", hash: "top" });
    }),
  );

  it.effect("lets a whole URL bypass the base only from an empty start", () =>
    Effect.gen(function* () {
      const whole = Request.path(Schema.String, (href) => href);
      const input = { path: "https://other.test/x" };
      const api = Request.baseUrl("https://api.test/v1");
      expect(yield* urlOf(Request.get("").pipe(api, whole), input)).toBe(
        "https://other.test/x",
      );
      expect(yield* urlOf(Request.get("/fetch/").pipe(api, whole), input)).toBe(
        "https://api.test/v1/fetch/https://other.test/x",
      );
    }),
  );

  it.effect("joins the base at its slash boundary, as it always did", () =>
    Effect.gen(function* () {
      for (const base of ["https://api.test/v1", "https://api.test/v1/"]) {
        const api = Request.baseUrl(base);
        expect(
          yield* urlOf(Request.get("").pipe(api, Request.path`/a`), undefined),
        ).toBe("https://api.test/v1/a");
        expect(
          yield* urlOf(Request.get("").pipe(api, Request.path`a`), undefined),
        ).toBe("https://api.test/v1/a");
      }
    }),
  );

  it.effect(
    "keeps a query on its own beside a base, where a template adds /",
    () =>
      Effect.gen(function* () {
        const base = Request.baseUrl("https://api.test/svc");
        expect(yield* urlOf(Request.get("?wsdl").pipe(base), undefined)).toBe(
          "https://api.test/svc?wsdl",
        );
        expect(
          yield* urlOf(
            Request.get("").pipe(base, Request.path`?wsdl`),
            undefined,
          ),
        ).toBe("https://api.test/svc/?wsdl");
      }),
  );

  it.effect("lets a native edit see the path so far, and adds to it", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const record = Request.mapEffect(
        (request: HttpClientRequest.HttpClientRequest) => {
          seen.push(request.url);
          return Effect.succeed(request);
        },
      );
      const moved = Request.mapEffect(
        (request: HttpClientRequest.HttpClientRequest) =>
          Effect.succeed(HttpClientRequest.setUrl(request, "/moved")),
      );
      expect(
        yield* urlOf(
          Request.get("/a").pipe(
            record,
            Request.path`/b`,
            record,
            moved,
            Request.path`/c`,
          ),
          undefined,
        ),
      ).toBe("/moved/c");
      expect(seen).toEqual(["/a", "/a/b"]);
    }),
  );
});

/** A generic helper: a template whose name its caller chooses. */
const atName =
  <const K extends string>(name: K) =>
  <I, E, R>(self: Request.Request<I, E, R>) =>
    self.pipe(Request.path`/${Request.pathValue(name)}`);

/** A generic helper: a renderer for any schema that encodes to text. */
const taskPath = <S extends Schema.Top & { readonly Encoded: string }>(
  schema: S,
  suffix = "",
) =>
  Request.path(schema, (id: string, encode) => `/tasks/${encode(id)}${suffix}`);

/** What a template writes for one value under `schema`. */
const written = <S extends Request.PathSchema>(
  schema: S,
  value: Request.Input<S>,
) =>
  urlOf(
    Request.get("").pipe(Request.path`/${Request.pathValue("value", schema)}`),
    { path: { value } } as never,
  );

// https://github.com/viell-dev/slop-effect-schema-http/issues/80
describe("a path template", () => {
  const base = "https://api.example.test/v1";
  const api = Request.baseUrl(base);
  const customer = Request.pathValue("customer");
  const calendar = Request.pathValue("calendar", Schema.FiniteFromString);
  const event = Request.pathValue("event");
  const thing = Request.pathValue("id");

  const getCalendar = Request.get("").pipe(
    api,
    Request.path`/customers/${customer}/calendars/${calendar}`,
  );

  describe("writes the path", () => {
    it.effect("renders a nested resource", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(getCalendar, {
            path: { customer: "a/b", calendar: 7 },
          }),
        ).toBe(`${base}/customers/a%2Fb/calendars/7`);
      }),
    );

    it.effect("lets a child add to a parent, stating only its own part", () =>
      Effect.gen(function* () {
        const getEvent = getCalendar.pipe(Request.path`/events/${event}`);
        expect(
          yield* urlOf(getEvent, {
            path: { customer: "a/b", calendar: 7, event: "c d" },
          }),
        ).toBe(`${base}/customers/a%2Fb/calendars/7/events/c%20d`);
      }),
    );

    it.effect("starts from a constructor's path", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("/customers").pipe(api, Request.path`/${customer}`),
            { path: { customer: "x" } },
          ),
        ).toBe(`${base}/customers/x`);
      }),
    );

    it.effect("puts a value inside a segment", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("").pipe(api, Request.path`/Customers('${customer}')`),
            { path: { customer: "x y" } },
          ),
        ).toBe(`${base}/Customers('x%20y')`);
      }),
    );

    it.effect("keeps a trailing slash, a literal colon and a suffix", () =>
      Effect.gen(function* () {
        const input = { path: { id: "x" } };
        expect(
          yield* urlOf(
            Request.get("").pipe(Request.path`/things/${thing}/orders/`),
            input,
          ),
        ).toBe("/things/x/orders/");
        expect(
          yield* urlOf(
            Request.post("").pipe(Request.path`/things/${thing}:archive`),
            input,
          ),
        ).toBe("/things/x:archive");
        expect(
          yield* urlOf(
            Request.get("").pipe(Request.path`/things/${thing}.json`),
            input,
          ),
        ).toBe("/things/x.json");
      }),
    );

    it.effect("takes no input when it has no values", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(Request.get("/a").pipe(Request.path`/b`), undefined),
        ).toBe("/a/b");
      }),
    );

    it.effect("can be only values, or start or end with one", () =>
      Effect.gen(function* () {
        const first = Request.pathValue("first");
        const second = Request.pathValue("second");
        const input = { path: { first: "a b", second: "c" } };
        expect(
          yield* urlOf(
            Request.get("").pipe(Request.path`${first}${second}`),
            input,
          ),
        ).toBe("a%20bc");
        expect(
          yield* urlOf(
            Request.get("").pipe(Request.path`${first}/x/${second}`),
            input,
          ),
        ).toBe("a%20b/x/c");
      }),
    );

    it.effect("gives every use of a name the one value", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("").pipe(Request.path`/a/${thing}/b/${thing}`),
            { path: { id: "x" } },
          ),
        ).toBe("/a/x/b/x");
      }),
    );

    it.effect("uses text exactly as written, even a backslash", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(
            Request.get("").pipe(Request.path`/a\b/${thing}\n/%2F/ c\`\${d}`),
            { path: { id: "x" } },
          ),
        ).toBe("/a\\b/x\\n/%2F/ c\\`\\${d}");
      }),
    );

    it.effect(
      "uses fixed text exactly as written, even an invalid escape",
      () =>
        Effect.gen(function* () {
          expect(
            yield* urlOf(
              Request.get("").pipe(Request.path`/a\b/\u`),
              undefined,
            ),
          ).toBe("/a\\b/\\u");
        }),
    );

    it.effect("adds nothing when it is empty", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(Request.get("/a").pipe(Request.path``), undefined),
        ).toBe("/a");
      }),
    );

    it.effect("can be a named transform that definitions share", () =>
      Effect.gen(function* () {
        const atThing = Request.path`/things/${thing}`;
        const input = { path: { id: "1" } };
        expect(yield* urlOf(Request.get("").pipe(api, atThing), input)).toBe(
          `${base}/things/1`,
        );
        expect(yield* urlOf(Request.post("/x").pipe(api, atThing), input)).toBe(
          `${base}/x/things/1`,
        );
      }),
    );

    it.effect("works through a generic helper", () =>
      Effect.gen(function* () {
        const tenant = Request.pathValue("tenant");
        const underTenant = <I, E, R>(self: Request.Request<I, E, R>) =>
          self.pipe(Request.path`/tenants/${tenant}`);
        const reports = Request.get("").pipe(
          api,
          underTenant,
          Request.path`/reports`,
          atName("report"),
        );
        expect(
          yield* urlOf(reports, { path: { tenant: "t/1", report: "r" } }),
        ).toBe(`${base}/tenants/t%2F1/reports/r`);
      }),
    );

    it.effect("works in a composed function", () =>
      Effect.gen(function* () {
        const toThing = flow(
          Request.path`/things/${thing}`,
          Request.path`/parts`,
        );
        expect(
          yield* urlOf(toThing(Request.get("")), { path: { id: "x" } }),
        ).toBe("/things/x/parts");
      }),
    );

    it.effect("works under Request.mapInput", () =>
      Effect.gen(function* () {
        const byId = Request.get("").pipe(
          Request.path`/things/${thing}`,
          Request.mapInput((id: string) => ({ path: { id } })),
        );
        expect(yield* urlOf(byId, "x")).toBe("/things/x");
      }),
    );
  });

  describe("reads each value through its schema", () => {
    it.effect("takes either side of the schema", () =>
      Effect.gen(function* () {
        const invoice = Request.pathValue("id", Schema.FiniteFromString);
        const request = Request.get("").pipe(
          Request.path`/invoices/${invoice}`,
        );
        for (const id of [42, "42", "042"]) {
          expect(yield* urlOf(request, { path: { id } })).toBe("/invoices/42");
        }
      }),
    );

    it.effect("takes a mix by value", () =>
      Effect.gen(function* () {
        const page = Request.pathValue("page", Schema.FiniteFromString);
        const size = Request.pathValue("size", Schema.FiniteFromString);
        expect(
          yield* urlOf(Request.get("").pipe(Request.path`/${page}/${size}`), {
            path: { page: 1, size: "2" },
          }),
        ).toBe("/1/2");
      }),
    );

    it.effect("is a string without a schema", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          compile(Request.get("").pipe(Request.path`/${thing}`), {
            path: { id: 7 },
          } as never),
        );
        expect(error).toBeInstanceOf(Schema.SchemaError);
      }),
    );

    it.effect("keeps a schema failure a SchemaError that names the value", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          compile(getCalendar, { path: { customer: "x", calendar: "many" } }),
        );
        expect(error).toBeInstanceOf(Schema.SchemaError);
        expect(error.message).toContain('["calendar"]');
      }),
    );

    it.effect.each([
      ["no field", { path: {} }],
      ["no group", {}],
      ["a scalar group", { path: 7 }],
      ["a null group", { path: null }],
    ] as const)("refuses %s with a SchemaError", ([, input]) =>
      Effect.gen(function* () {
        const request = Request.get("").pipe(Request.path`/${thing}`);
        const error = yield* Effect.flip(compile(request, input as never));
        expect(error).toBeInstanceOf(Schema.SchemaError);
      }),
    );

    it.effect("ignores the other names under path", () =>
      Effect.gen(function* () {
        expect(
          yield* urlOf(Request.get("").pipe(Request.path`/${thing}`), {
            path: { id: "x", other: 1 },
          } as never),
        ).toBe("/x");
      }),
    );

    it.effect("writes every scalar a schema can encode to", () =>
      Effect.gen(function* () {
        expect(yield* written(Schema.Number, 0)).toBe("/0");
        expect(yield* written(Schema.Number, 1e21)).toBe("/1e%2B21");
        expect(yield* written(Schema.Boolean, false)).toBe("/false");
        expect(yield* written(Schema.BigInt, 7n)).toBe("/7");
        expect(yield* written(Schema.String, "")).toBe("/");
        expect(yield* written(Schema.Literals(["a", "b"]), "b")).toBe("/b");
        expect(
          yield* written(Schema.Union([Schema.String, Schema.Number]), 7),
        ).toBe("/7");
        expect(yield* written(Schema.DateFromString, new Date(0))).toBe(
          "/1970-01-01T00%3A00%3A00.000Z",
        );
      }),
    );

    it.effect("takes a plain value in a branded schema", () =>
      Effect.gen(function* () {
        const branded = Request.pathValue(
          "id",
          Schema.String.pipe(Schema.brand("ThingId")),
        );
        expect(
          yield* urlOf(Request.get("").pipe(Request.path`/${branded}`), {
            path: { id: "x" },
          }),
        ).toBe("/x");
      }),
    );

    it.effect("reads a name that JavaScript objects already have", () =>
      Effect.gen(function* () {
        for (const name of ["__proto__", "constructor", "toString", ""]) {
          const value = Request.pathValue(name);
          const request = Request.get("").pipe(Request.path`/${value}`);
          expect(yield* urlOf(request, { path: { [name]: "v" } })).toBe("/v");
          const error = yield* Effect.flip(compile(request, { path: {} }));
          expect(error).toBeInstanceOf(Schema.SchemaError);
        }
      }),
    );

    it.effect("needs the schema's services", () =>
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
        const tenanted = Request.pathValue("who", Tenanted);
        const request = Request.get("").pipe(Request.path`/${tenanted}`);
        type Needs = Effect.Services<ReturnType<typeof request.prepare>>;
        expectTypeOf<Needs>().toEqualTypeOf<Tenant>();
        expect(
          yield* urlOf(request, { path: { who: "me" } }).pipe(
            Effect.provideService(Tenant, "t1"),
          ),
        ).toBe("/me");
      }),
    );

    it.effect("refuses a value a schema lets past its type", () =>
      Effect.gen(function* () {
        const loose = Request.pathValue("id", Schema.Any);
        const optional = Request.pathValue(
          "id",
          Schema.optionalKey(Schema.String),
        );
        const cases = [
          [Request.get("").pipe(Request.path`/${loose}`), { id: { a: 1 } }],
          [Request.get("").pipe(Request.path`/${optional}`), {}],
        ] as const;
        for (const [request, path] of cases) {
          const error = yield* Effect.flip(
            compile(request as Request.Request<unknown, unknown>, { path }),
          );
          expect(error).toBeInstanceOf(Request.InvalidRequest);
          expect(error).toHaveProperty(
            "message",
            'The path value "id" did not encode to one value',
          );
        }
      }),
    );
  });

  describe("encodes each value", () => {
    it.effect("with the active path encoder, and never the text", () =>
      Effect.gen(function* () {
        const url = yield* urlOf(
          Request.get("").pipe(Request.path`/a b/${thing}/c d`),
          { path: { id: "x" } },
        ).pipe(
          Effect.provide(
            UrlEncoding.layer({
              ...UrlEncoding.defaults,
              path: (value) => `[${value}]`,
            }),
          ),
        );
        expect(url).toBe("/a b/[x]/c d");
      }),
    );

    it.effect("keeps a value from adding URL syntax of its own", () =>
      Effect.gen(function* () {
        expect(
          yield* targetOf(Request.get("").pipe(Request.path`/${thing}/x`), {
            path: { id: "a/b?c=1#d%20" },
          }),
        ).toEqual({ url: "/a%2Fb%3Fc%3D1%23d%2520/x", hash: undefined });
      }),
    );

    it.effect("fails with InvalidRequest when a value cannot be encoded", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          compile(Request.get("").pipe(Request.path`/${thing}`), {
            path: { id: loneSurrogate },
          }),
        );
        expect(error).toBeInstanceOf(Request.InvalidRequest);
        expect(error.cause).toBeInstanceOf(URIError);
      }),
    );

    it.effect("fails with InvalidRequest when a replaced encoder throws", () =>
      Effect.gen(function* () {
        const refused = new Error("segment refused");
        const error = yield* Effect.flip(
          compile(Request.get("").pipe(Request.path`/${thing}`), {
            path: { id: "x" },
          }).pipe(
            Effect.provide(
              UrlEncoding.layer({
                ...UrlEncoding.defaults,
                path: () => {
                  throw refused;
                },
              }),
            ),
          ),
        );
        expect(error).toBeInstanceOf(Request.InvalidRequest);
        expect(error.cause).toBe(refused);
      }),
    );

    it.effect(
      "keeps .., an empty value and a quote, which it cannot help",
      () =>
        Effect.gen(function* () {
          const request = Request.get("").pipe(
            Request.path`/Customers('${thing}')`,
          );
          expect(yield* urlOf(request, { path: { id: ".." } })).toBe(
            "/Customers('..')",
          );
          expect(yield* urlOf(request, { path: { id: "" } })).toBe(
            "/Customers('')",
          );
          expect(yield* urlOf(request, { path: { id: "O'Brien" } })).toBe(
            "/Customers('O'Brien')",
          );
          expect(
            yield* urlOf(
              Request.get("").pipe(Request.path`/customers/${thing}/orders/`),
              { path: { id: ".." } },
            ),
          ).toBe("/customers/../orders/");
          expect(
            yield* urlOf(
              Request.get("").pipe(Request.path`/customers/${thing}/orders/`),
              { path: { id: "" } },
            ),
          ).toBe("/customers//orders/");
        }),
    );

    it.effect("leaves constraining a value to its schema", () =>
      Effect.gen(function* () {
        const invoice = Request.pathValue(
          "invoice",
          Schema.TemplateLiteral(["inv-", Schema.Int]),
        );
        const slug = Request.pathValue(
          "slug",
          Schema.String.check(Schema.isPattern(/^[a-z0-9-]+$/)),
        );
        const request = Request.get("").pipe(
          Request.path`/invoices/${invoice}/${slug}`,
        );
        expect(
          yield* urlOf(request, { path: { invoice: "inv-7", slug: "a-b" } }),
        ).toBe("/invoices/inv-7/a-b");
        for (const path of [
          { invoice: "..", slug: "a-b" },
          { invoice: "inv-7", slug: ".." },
          { invoice: "inv-7", slug: "" },
        ]) {
          const error = yield* Effect.flip(
            compile(request, { path: path as never }),
          );
          expect(error).toBeInstanceOf(Schema.SchemaError);
        }
      }),
    );
  });

  describe("shares the path input with other bindings", () => {
    it.effect("mixes with a struct renderer", () =>
      Effect.gen(function* () {
        const request = Request.get("").pipe(
          Request.path`/a/${thing}`,
          Request.path(
            Schema.Struct({ rest: Schema.String }),
            ({ rest }, encode) => `/${rest.split("/").map(encode).join("/")}`,
          ),
        );
        expect(
          yield* urlOf(request, { path: { id: "x", rest: "b c/d" } }),
        ).toBe("/a/x/b%20c/d");
      }),
    );

    it.effect("mixes with a class renderer", () =>
      Effect.gen(function* () {
        class Rest extends Schema.Class<Rest>("Rest")({
          rest: Schema.String,
        }) {}
        const request = Request.get("").pipe(
          Request.path(Rest, ({ rest }, encode) => `/${encode(rest)}`),
          Request.path`/a/${thing}`,
        );
        expect(yield* urlOf(request, { path: { id: "x", rest: "b" } })).toBe(
          "/b/a/x",
        );
      }),
    );

    it.effect("gives one value to the same name at two levels", () =>
      Effect.gen(function* () {
        const request = Request.get("").pipe(
          Request.path`/a/${thing}`,
          Request.path`/b/${thing}`,
        );
        expect(yield* urlOf(request, { path: { id: "x" } })).toBe("/a/x/b/x");
      }),
    );

    it.effect(
      "fails at run time on one name with two schemas in a template",
      () =>
        Effect.gen(function* () {
          const asText = Request.pathValue("id");
          const asNumber = Request.pathValue("id", Schema.Finite);
          const request = Request.get("").pipe(
            Request.path`/a/${asText}/b/${asNumber}`,
          );
          const error = yield* Effect.flip(
            compile(request, { path: { id: 7 } }),
          );
          expect(error).toBeInstanceOf(Schema.SchemaError);
        }),
    );

    it.effect("shares one value between two scalar renderers", () =>
      Effect.gen(function* () {
        const request = Request.get("").pipe(
          Request.path(Schema.String, (id, encode) => `/a/${encode(id)}`),
          Request.path(Schema.String, (id, encode) => `/b/${encode(id)}`),
        );
        expect(yield* urlOf(request, { path: "x" })).toBe("/a/x/b/x");
      }),
    );
  });

  describe("stays with the renderer for a shape that depends on the value", () => {
    it.effect("a whole URL", () =>
      Effect.gen(function* () {
        const request = Request.get("").pipe(
          api,
          Request.path(Schema.String, (href) => href),
        );
        expect(yield* urlOf(request, { path: "https://other.test/x" })).toBe(
          "https://other.test/x",
        );
      }),
    );

    it.effect("a value holding several segments", () =>
      Effect.gen(function* () {
        const request = Request.get("").pipe(
          Request.path(Schema.String, (value, encode) =>
            value.split("/").map(encode).join("/"),
          ),
        );
        expect(yield* urlOf(request, { path: "/a b/c" })).toBe("/a%20b/c");
      }),
    );

    it.effect("a path that branches on the value", () =>
      Effect.gen(function* () {
        const request = Request.get("/dav").pipe(
          Request.path(Schema.String, (name, encode) =>
            name === "" ? "/" : `/${encode(name)}/`,
          ),
        );
        expect(yield* urlOf(request, { path: "" })).toBe("/dav/");
        expect(yield* urlOf(request, { path: "a b" })).toBe("/dav/a%20b/");
      }),
    );
  });

  describe("types", () => {
    type InputOf<Q> =
      Q extends Request.Request<infer I, infer _E, infer _R> ? I : never;

    it("infers named values, either side of each schema", () => {
      expectTypeOf<InputOf<typeof getCalendar>>().toEqualTypeOf<{
        readonly path: {
          readonly customer: string;
          readonly calendar: string | number;
        };
      }>();
    });

    it("adds a child's names to its parent's", () => {
      const getEvent = getCalendar.pipe(Request.path`/events/${event}`);
      void Request.compile(getEvent, {
        path: { customer: "a", calendar: 7, event: "e" },
      });
      // @ts-expect-error: the parent's names are still required
      void Request.compile(getEvent, { path: { event: "e" } });
      // @ts-expect-error: the child's name is required
      void Request.compile(getEvent, { path: { customer: "a", calendar: 7 } });
    });

    it("keeps the type of a request given only fixed text", () => {
      const request = Request.get("/a").pipe(Request.path`/b`);
      expectTypeOf(request).toEqualTypeOf<Request.Request<unknown>>();
    });

    it("adds its failures to a request with values", () => {
      expectTypeOf<
        Effect.Error<ReturnType<typeof getCalendar.prepare>>
      >().toEqualTypeOf<Schema.SchemaError | Request.InvalidRequest>();
    });

    it("compiles in a generic helper", () => {
      const request = Request.get("").pipe(atName("tenant"));
      void Request.compile(request, { path: { tenant: "a" } });
      // @ts-expect-error: the helper's name is what the input needs
      void Request.compile(request, { path: { tenent: "a" } });
    });

    it("rejects a misspelt or missing name", () => {
      void Request.compile(getCalendar, {
        // @ts-expect-error: the value is named `customer`
        path: { custmer: "a", calendar: 7 },
      });
      // @ts-expect-error: `calendar` is missing
      void Request.compile(getCalendar, { path: { customer: "a" } });
      // @ts-expect-error: the path group is missing
      void Request.compile(getCalendar, {});
      // @ts-expect-error: a template's input is named, not positional
      void Request.compile(getCalendar, { path: ["a", 7] });
    });

    it("rejects a value on neither side of its schema", () => {
      void Request.compile(getCalendar, {
        // @ts-expect-error: a boolean is on neither side of the schema
        path: { customer: "a", calendar: true },
      });
    });

    // These never run, because a definition that does not compile also throws.
    it("rejects anything but a path value in a template", () => {
      const id: string = "a/b";
      const count: number = 7;
      void (() => {
        // @ts-expect-error: a raw string would miss the schema and the encoder
        void Request.path`/x/${id}`;
        // @ts-expect-error: the same with another value next to it
        void Request.path`/x/${id}/y/${customer}`;
        // @ts-expect-error: a number is no more a path value than a string
        void Request.path`/x/${count}`;
        // @ts-expect-error: a schema needs a name, through `Request.pathValue`
        void Request.path`/x/${Schema.String}`;
      });
    });

    it("rejects parentheses in place of a template", () => {
      const id: string = "a/b";
      void (() => {
        // @ts-expect-error: a call with one string is not a template
        void Request.path(`/x/${id}`);
        // @ts-expect-error: a renderer needs its schema
        void Request.path((value: string) => `/x/${value}`);
        // @ts-expect-error: a schema needs its renderer
        void Request.path(Schema.String);
      });
    });

    it("rejects a schema that is not one scalar value", () => {
      // @ts-expect-error: a struct is several values
      void Request.pathValue("a", Schema.Struct({ b: Schema.String }));
      // @ts-expect-error: a list is several values
      void Request.pathValue("a", Schema.Array(Schema.String));
      // @ts-expect-error: a tuple is several values
      void Request.pathValue("a", Schema.Tuple([Schema.String]));
      // @ts-expect-error: a `Date` has no obvious URL text
      void Request.pathValue("a", Schema.Date);
      // @ts-expect-error: `null` is not a value in a path
      void Request.pathValue("a", Schema.NullOr(Schema.String));
      // @ts-expect-error: a path value is never absent
      void Request.pathValue("a", Schema.optional(Schema.String));
      // @ts-expect-error: an unknown value may be anything
      void Request.pathValue("a", Schema.Unknown);
      // @ts-expect-error: a name is text
      void Request.pathValue(7);
    });

    it("rejects a scalar renderer stacked with a template", () => {
      const request = Request.get("").pipe(
        Request.path(Schema.String, (id, encode) => `/${encode(id)}`),
        Request.path`/${thing}`,
      );
      // @ts-expect-error: the input cannot be text and fields at once
      void Request.compile(request, { path: "x" });
      // @ts-expect-error: the input cannot be fields and text at once
      void Request.compile(request, { path: { id: "x" } });
    });

    it("rejects one name with incompatible types at two levels", () => {
      const asNumber = Request.pathValue("id", Schema.Finite);
      const request = Request.get("").pipe(
        Request.path`/a/${thing}`,
        Request.path`/b/${asNumber}`,
      );
      // @ts-expect-error: no value is both a string and a number
      void Request.compile(request, { path: { id: "x" } });
      // @ts-expect-error: no value is both a number and a string
      void Request.compile(request, { path: { id: 7 } });
    });

    it("still compiles a renderer in a generic helper", () => {
      const request = Request.get("").pipe(taskPath(Schema.String, "/history"));
      void Request.compile(request, { path: "a" });
      // @ts-expect-error: the schema takes text
      void Request.compile(request, { path: 7 });
    });

    it("still infers a renderer's value from its schema", () => {
      const request = Request.get("").pipe(
        Request.path(Schema.Struct({ a: Schema.String }), ({ a }, encode) =>
          encode(a),
        ),
      );
      void Request.compile(request, { path: { a: "x" } });
      void Request.get("").pipe(
        // @ts-expect-error: the schema has no `b`
        Request.path(Schema.Struct({ a: Schema.String }), ({ b }) => b),
      );
    });
  });
});

describe("Request.setPath", () => {
  const id = Request.pathValue("id");

  it.effect("replaces the constructor's path and keeps the bindings", () =>
    Effect.gen(function* () {
      const current = Request.get("/customers").pipe(Request.path`/${id}/a`);
      const moved = current.pipe(Request.setPath("/people"));
      const input = { path: { id: "x" } };
      expect(yield* urlOf(moved, input)).toBe("/people/x/a");
      expect(yield* urlOf(current, input)).toBe("/customers/x/a");
    }),
  );

  it.effect("keeps the constructor's query and fragment", () =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(
          Request.get("/a?wsdl#top").pipe(Request.setPath("/b")),
          undefined,
        ),
      ).toEqual({ url: "/b?wsdl", hash: "top" });
    }),
  );

  it.effect("treats a ? or # as URL text, as a template does", () =>
    Effect.gen(function* () {
      expect(
        yield* targetOf(
          Request.get("/a?q=1").pipe(Request.setPath("/b?x=1#y")),
          undefined,
        ),
      ).toEqual({ url: "/b?x=1&q=1", hash: "y" });
    }),
  );

  it.effect("wins over an earlier call, and can empty the path", () =>
    Effect.gen(function* () {
      expect(
        yield* urlOf(
          Request.get("/a").pipe(Request.setPath("/b"), Request.setPath("/c")),
          undefined,
        ),
      ).toBe("/c");
      expect(
        yield* urlOf(
          Request.get("/a").pipe(
            Request.baseUrl("https://api.test/v1"),
            Request.setPath(""),
          ),
          undefined,
        ),
      ).toBe("https://api.test/v1");
    }),
  );

  it("keeps the request's type", () => {
    const request = Request.get("/a").pipe(Request.path`/${id}`);
    expectTypeOf(request.pipe(Request.setPath("/b"))).toEqualTypeOf(request);
  });
});

describe("Request.unbind and the path", () => {
  const api = Request.baseUrl("https://api.test/v1");
  const id = Request.pathValue("id");
  const count = Request.pathValue("count", Schema.FiniteFromString);
  const parent = Request.get("/customers").pipe(
    api,
    Request.path`/${id}/calendars/${count}`,
  );

  it.effect("removes the values and the text a template added", () =>
    Effect.gen(function* () {
      const request = parent.pipe(Request.unbind("path"));
      expectTypeOf(request).toEqualTypeOf<
        Request.Request<unknown, Schema.SchemaError | Request.InvalidRequest>
      >();
      expect(yield* urlOf(request, undefined)).toBe(
        "https://api.test/v1/customers",
      );
    }),
  );

  it.effect("removes fixed text and a renderer's text in order", () =>
    Effect.gen(function* () {
      const request = Request.get("/a").pipe(
        Request.path`/b`,
        Request.path(
          Schema.Struct({ c: Schema.String }),
          ({ c }, encode) => `/${encode(c)}`,
        ),
        Request.path`/d`,
        Request.unbind("path"),
        Request.path`/e`,
      );
      expect(yield* urlOf(request, undefined)).toBe("/a/e");
    }),
  );

  it.effect("leaves the input of what comes after it", () =>
    Effect.gen(function* () {
      const request = parent.pipe(
        Request.unbind("path"),
        Request.path`/legacy/${count}`,
      );
      expect(yield* urlOf(request, { path: { count: 7 } })).toBe(
        "https://api.test/v1/customers/legacy/7",
      );
    }),
  );

  it.effect("needs setPath to change the constructor's text", () =>
    Effect.gen(function* () {
      for (const request of [
        parent.pipe(
          Request.unbind("path"),
          Request.setPath("/legacy"),
          Request.path`/${count}`,
        ),
        parent.pipe(
          Request.setPath("/legacy"),
          Request.unbind("path"),
          Request.path`/${count}`,
        ),
      ]) {
        expect(yield* urlOf(request, { path: { count: 7 } })).toBe(
          "https://api.test/v1/legacy/7",
        );
      }
    }),
  );

  it.effect("skips a template under Request.mapInput", () =>
    Effect.gen(function* () {
      const request = Request.get("/a").pipe(
        Request.path`/${id}`,
        Request.mapInput((value: string) => ({ path: { id: value } })),
        Request.unbind("path"),
      );
      expect(yield* urlOf(request, "x")).toBe("/a");
    }),
  );

  it.effect("makes a variant from a named transform", () =>
    Effect.gen(function* () {
      const toLegacyPath = flow(
        Request.unbind("path"),
        Request.setPath(""),
        Request.path`/legacy/calendars/${count}`,
      );
      expect(yield* urlOf(toLegacyPath(parent), { path: { count: 7 } })).toBe(
        "https://api.test/v1/legacy/calendars/7",
      );
    }),
  );
});
