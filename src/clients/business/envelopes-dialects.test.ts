import { describe, expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import * as Dialect from "./envelopes-dialects.js";
import * as Envelopes from "./envelopes.js";

/*
 * Round trips and negative cases for the consumer's dialect schemas. "Round trip" means:
 * `decode(encode(value))` equals `value` for every domain value, and `encode(decode(wire))` equals
 * `wire` for the server's canonical spelling. Looser spellings are refused rather than normalized, so
 * the mappings stay reversible.
 */

const roundTrips = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  wire: S["Encoded"],
  value: S["Type"],
) => {
  expect(Schema.decodeUnknownSync(schema)(wire)).toEqual(value);
  expect(Schema.encodeSync(schema)(value)).toEqual(wire);
};

const refuses = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  wire: unknown,
  message?: RegExp,
) => {
  const result = Schema.decodeUnknownResult(schema)(wire);
  expect(Result.isFailure(result)).toBe(true);
  if (message !== undefined && Result.isFailure(result))
    expect(result.failure.message).toMatch(message);
};

describe("business envelopes: dialect schemas", () => {
  it("[PAY-1] the anti-hijacking prefix round-trips and is required", () => {
    const schema = Dialect.prefixed(")]}',\n");
    roundTrips(schema, `)]}',\n{"openOrders":1}`, `{"openOrders":1}`);
    refuses(schema, `{"openOrders":1}`, /anti-hijacking prefix/);
    refuses(schema, `)]}'\n{"openOrders":1}`, /anti-hijacking prefix/);
    refuses(schema, `while(1);{"openOrders":1}`, /anti-hijacking prefix/);
  });

  it("[PAY-1] a JSONP frame round-trips for its callback and refuses any other", () => {
    const schema = Dialect.jsonp("showRates");
    roundTrips(
      schema,
      `/**/ typeof showRates === 'function' && showRates({"base":"USD"});`,
      `{"base":"USD"}`,
    );
    refuses(
      schema,
      `/**/ typeof otherWidget === 'function' && otherWidget({"base":"USD"});`,
      /calls otherWidget, not the requested showRates/,
    );
    refuses(schema, `showRates({"base":"USD"});`, /Express JSONP frame/);
    refuses(
      schema,
      `/**/ typeof showRates === 'function' && showRates({"base":"USD"})`,
      /Express JSONP frame/,
    );
    const invalid = Schema.encodeResult(Dialect.jsonp("alert(1)//"))("{}");
    expect(Result.isFailure(invalid)).toBe(true);
    refuses(Dialect.CallbackName, "alert(1)//", /identifier/);
    refuses(Dialect.CallbackName, "", /identifier/);
  });

  it("[PAY-2] lossless JSON keeps 64-bit ids exact in both directions", () => {
    const schema = Dialect.losslessJson(
      Schema.Struct({ id: Dialect.ExactId, amount: Schema.Number }),
    );
    roundTrips(schema, `{"id":9007199254740993,"amount":1.5}`, {
      id: 9007199254740993n,
      amount: 1.5,
    });
    // Safe ids are numbers on the wire and bigints in the domain.
    roundTrips(schema, `{"id":42,"amount":0}`, { id: 42n, amount: 0 });
    // The platform parser cannot express the id; the lossless one keeps every digit.
    expect(JSON.parse(`{"id":9007199254740993}`)).toEqual({
      id: 9007199254740992,
    });
  });

  it("[PAY-2] an exact id refuses a value the platform parser already rounded", () => {
    refuses(Dialect.ExactId, 9007199254740992);
    refuses(Dialect.ExactId, "9007199254740993");
    refuses(Dialect.ExactId, 0);
    refuses(Dialect.ExactId, -5n);
    refuses(Dialect.ExactId, 1.5);
  });

  it("[PAY-1] an OData count round-trips as canonical digits only", () => {
    roundTrips(Dialect.CountFromString, "3", 3);
    roundTrips(Dialect.CountFromString, "0", 0);
    for (const looser of ["03", "3.0", " 3", "-1", "", "+3", "1e2"])
      refuses(Dialect.CountFromString, looser, /canonical decimal digits/);
    refuses(Dialect.CountFromString, 3);
  });

  it("[PAY-1] a grid maps rows through its verified header and encodes the documented order", () => {
    const records = [
      { customerId: 1001, name: "A", current: 10, overdue30: 0 },
      { customerId: 1002, name: "B", current: 5, overdue30: 7 },
    ];
    roundTrips(
      Envelopes.AgingReport,
      {
        columns: ["customerId", "name", "current", "overdue30"],
        rows: [
          [1001, "A", 10, 0],
          [1002, "B", 5, 7],
        ],
      },
      records,
    );
    // Any column order decodes to the same records; it encodes back in the documented order.
    expect(
      Schema.decodeUnknownSync(Envelopes.AgingReport)({
        columns: ["overdue30", "name", "customerId", "current"],
        rows: [
          [0, "A", 1001, 10],
          [7, "B", 1002, 5],
        ],
      }),
    ).toEqual(records);
    const valid = ["customerId", "name", "current", "overdue30"];
    refuses(
      Envelopes.AgingReport,
      { columns: ["customerId", "current", "overdue30"], rows: [] },
      /missing column name/,
    );
    refuses(
      Envelopes.AgingReport,
      { columns: [...valid, "name"], rows: [] },
      /column name appears twice/,
    );
    refuses(
      Envelopes.AgingReport,
      { columns: [...valid, "overdue60"], rows: [] },
      /unexpected column overdue60/,
    );
    refuses(
      Envelopes.AgingReport,
      { columns: valid, rows: [[1001, "A", 10]] },
      /row 0 has 3 cells for 4 columns/,
    );
    refuses(Envelopes.AgingReport, {
      columns: valid,
      rows: [[1001, "A", "10", 0]],
    });
  });

  it("[PAY-1] an unwrapped list round-trips for none, one and many items", () => {
    const amsterdam = { code: "AMS1", city: "Amsterdam" };
    const frankfurt = { code: "FRA2", city: "Frankfurt" };
    roundTrips(Envelopes.WarehouseDirectory, {}, { warehouses: [] });
    roundTrips(
      Envelopes.WarehouseDirectory,
      { warehouse: amsterdam },
      { warehouses: [amsterdam] },
    );
    roundTrips(
      Envelopes.WarehouseDirectory,
      { warehouse: [amsterdam, frankfurt] },
      { warehouses: [amsterdam, frankfurt] },
    );
    // Arrays of fewer than two items are not the bridge's spelling.
    refuses(Envelopes.WarehouseDirectory, { warehouse: [] });
    refuses(Envelopes.WarehouseDirectory, { warehouse: [amsterdam] });
    refuses(Envelopes.WarehouseDirectory, { warehouse: null });
  });

  it("[PAY-1] a tier is a name in requests and an ordinal in responses", () => {
    roundTrips(Envelopes.TierOrdinal, 2, "GOLD");
    roundTrips(Envelopes.TierOrdinal, 0, "STANDARD");
    roundTrips(Envelopes.TierName, "PLATINUM", "PLATINUM");
    for (const wrong of ["GOLD", "2", 4, -1, 1.5])
      refuses(Envelopes.TierOrdinal, wrong);
    for (const wrong of ["gold", "Gold", 2]) refuses(Envelopes.TierName, wrong);
  });

  it("[HDR-2] the gateway's Link spelling round-trips and looser spellings are refused", () => {
    const wire = `</v1/customers?offset=0&limit=2>; rel="first", </v1/customers?offset=4&limit=2>; rel="last"`;
    roundTrips(Dialect.LinkHeader, wire, [
      { target: "/v1/customers?offset=0&limit=2", rel: "first" },
      { target: "/v1/customers?offset=4&limit=2", rel: "last" },
    ]);
    refuses(
      Dialect.LinkHeader,
      `</v1/customers?offset=0&limit=2>; rel=first`,
      /unexpected link/,
    );
    refuses(
      Dialect.LinkHeader,
      `</v1/customers?offset=0&limit=2>; rel="first"; title="x"`,
      /unexpected link/,
    );
    refuses(
      Dialect.LinkHeader,
      `/v1/customers?offset=0&limit=2; rel="first"`,
      /unexpected link/,
    );
  });

  it("[HDR-2] a zero-based window converts to a one-based page and back", () => {
    roundTrips(
      Dialect.PageFromWindow,
      { offset: 0, limit: 2 },
      { page: 1, perPage: 2 },
    );
    roundTrips(
      Dialect.PageFromWindow,
      { offset: 4, limit: 2 },
      { page: 3, perPage: 2 },
    );
    refuses(
      Dialect.PageFromWindow,
      { offset: 3, limit: 2 },
      /not on a page boundary/,
    );
    refuses(Dialect.PageFromWindow, { offset: 0, limit: 0 });
    refuses(Dialect.PageFromWindow, { offset: -2, limit: 2 });
  });

  it("[HDR-2] pagination links decode to pages and encode to the gateway's header", () => {
    const schema = Dialect.pageLinks("/v1/customers");
    roundTrips(
      schema,
      `</v1/customers?offset=0&limit=2>; rel="first", </v1/customers?offset=0&limit=2>; rel="prev", ` +
        `</v1/customers?offset=4&limit=2>; rel="next", </v1/customers?offset=4&limit=2>; rel="last"`,
      {
        first: { page: 1, perPage: 2 },
        prev: { page: 1, perPage: 2 },
        next: { page: 3, perPage: 2 },
        last: { page: 3, perPage: 2 },
      },
    );
    roundTrips(
      schema,
      `</v1/customers?offset=0&limit=5>; rel="first", </v1/customers?offset=0&limit=5>; rel="last"`,
      {
        first: { page: 1, perPage: 5 },
        last: { page: 1, perPage: 5 },
      },
    );
    const first = `</v1/customers?offset=0&limit=2>; rel="first"`;
    refuses(schema, first, /first and last links are required/);
    refuses(
      schema,
      `${first}, </v1/customers?offset=2&limit=2>; rel="self"`,
      /unexpected relation self/,
    );
    refuses(schema, `${first}, ${first}`, /relation first appears twice/);
    refuses(
      schema,
      `${first}, </v1/orders?offset=2&limit=2>; rel="last"`,
      /expected \/v1\/customers/,
    );
    refuses(
      schema,
      `${first}, </v1/customers?offset=02&limit=2>; rel="last"`,
      /expected \/v1\/customers/,
    );
    refuses(
      schema,
      `${first}, </v1/customers?limit=2&offset=2>; rel="last"`,
      /expected \/v1\/customers/,
    );
  });

  it("[STAT-2] a Location resolves against its request URL and refuses to encode", () => {
    const request = "http://api.test/v1/customers";
    const resolve = Schema.decodeUnknownSync(Dialect.locationAgainst(request));
    expect(resolve("/v1/customers/1006").href).toBe(
      "http://api.test/v1/customers/1006",
    );
    expect(resolve("customers/1006").href).toBe(
      "http://api.test/v1/customers/1006",
    );
    expect(resolve("http://api.test/v1/customers/1006").href).toBe(
      "http://api.test/v1/customers/1006",
    );
    const reverse = Schema.encodeResult(Dialect.locationAgainst(request))(
      new URL("http://api.test/v1/customers/1006"),
    );
    expect(Result.isFailure(reverse)).toBe(true);
    if (Result.isFailure(reverse))
      expect(reverse.failure.message).toMatch(
        /relative or absolute spelling is lost/,
      );
  });
});
