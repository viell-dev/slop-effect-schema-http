/**
 * PAY-1: the business API's rates against stock Express 5.3.0 res.jsonp. Backend-side and
 * Node-only: read the real recordings from disk and compare raw HTTP status/header lines and
 * body bytes. The responses are data, never executed as scripts.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import type { Backend, Json } from "../harness/lane.js";
import {
  data,
  date,
  differences,
  masked,
  recorded,
  type Recorded,
  type Response,
  send,
} from "./recordings.js";

const rates = {
  base: "USD",
  rates: { EUR: "0.9150", GBP: "0.7890", JPY: "149.2000" },
} satisfies Json;

interface Case {
  readonly name: string;
  readonly target: string;
  /** The callback Express actually wrote, after selection and sanitization; null means JSON. */
  readonly callback: string | null;
  readonly etag: string;
  readonly rejected?: boolean;
}

const cases: ReadonlyArray<Case> = [
  {
    name: "plain-json",
    target: "/v1/rates",
    callback: null,
    etag: 'W/"47-g3/aWo26IppyKiJOivhIKVM1+II"',
  },
  {
    name: "show-rates",
    target: "/v1/rates?callback=showRates",
    callback: "showRates",
    etag: 'W/"7b-igh39wkjBjtpZCDtrjHr48hyba0"',
  },
  {
    name: "other-widget",
    target: "/v1/rates?callback=otherWidget",
    callback: "otherWidget",
    etag: 'W/"7f-FziS0ZO1mI9FFoCC09ZuDG7WeNc"',
  },
  {
    name: "identifier-symbols",
    target: "/v1/rates?callback=_%24rates2",
    callback: "_$rates2",
    etag: 'W/"79-FZJS3zrROcCSOFF1ueyIO5Um0E4"',
  },
  {
    name: "empty-callback",
    target: "/v1/rates?callback=",
    callback: null,
    etag: 'W/"47-g3/aWo26IppyKiJOivhIKVM1+II"',
    rejected: true,
  },
  {
    name: "sanitized-callback",
    target: "/v1/rates?callback=alert%281%29%2F%2F",
    callback: "alert1",
    etag: 'W/"75-sHhbfP6A2zmRoHCvs4aXL7FUo28"',
    rejected: true,
  },
  {
    name: "dotted-callback",
    target: "/v1/rates?callback=widget.showRates",
    callback: "widget.showRates",
    etag: 'W/"89-NmqcMmFYXPZ0kUjhLpT+3NIHYPg"',
    rejected: true,
  },
  {
    name: "repeated-callback",
    target: "/v1/rates?callback=showRates&callback=otherWidget",
    callback: "showRates",
    etag: 'W/"7b-igh39wkjBjtpZCDtrjHr48hyba0"',
  },
];

const requestLines = [
  ["Host", "business.example"],
  ["Connection", "close"],
] as const;

/** Every recorded request is sent unchanged, including its Host and encoded/repeated query. */
const exchangeFor = (test: Case): Recorded => {
  const exchange = recorded("express-jsonp", test.name);
  expect(exchange.request).toEqual(
    Buffer.from(
      `GET ${test.target} HTTP/1.1\r\nHost: business.example\r\nConnection: close\r\n\r\n`,
      "ascii",
    ),
  );
  return exchange;
};

/** Exact framing and JSON bytes also pin every property, value, decimal spelling and key order. */
const expectRates = (response: Response, callback: string | null): void => {
  const prefix =
    callback === null
      ? ""
      : `/**/ typeof ${callback} === 'function' && ${callback}(`;
  const suffix = callback === null ? "" : ");";
  const json = JSON.stringify(rates);
  expect(response.body).toEqual(
    Buffer.from(`${prefix}${json}${suffix}`, "utf8"),
  );
  const body = response.body.toString("utf8");
  const value = JSON.parse(
    body.slice(prefix.length, body.length - suffix.length),
  ) as unknown;
  expect(value).toEqual(rates);
  expect(JSON.stringify(value)).toBe(json);
};

/** Pin all of Express's deterministic header lines in order, including its body-specific ETag. */
const expectExpress = (test: Case, response: Response): void => {
  expectRates(response, test.callback);
  expect([response.status, response.reason]).toEqual([200, "OK"]);
  expect(response.lines).toEqual([
    ["X-Powered-By", "Express"],
    ["X-Content-Type-Options", "nosniff"],
    [
      "Content-Type",
      test.callback === null
        ? "application/json; charset=utf-8"
        : "text/javascript; charset=utf-8",
    ],
    ["Content-Length", String(response.body.length)],
    ["ETag", test.etag],
    ["Date", "<date>"],
    ["Connection", "close"],
  ]);
};

/** Pin the service's deliberate header policy, without dropping any line from either response. */
const expectBusiness = (
  response: Response,
  callback: string | null,
  cache: "MISS" | "HIT" | "rejected",
): void => {
  const rejected = cache === "rejected";
  expect([response.status, response.reason]).toEqual(
    rejected ? [400, "Bad Request"] : [200, "OK"],
  );
  expect(response.lines).toEqual([
    [
      "Content-Type",
      rejected
        ? "text/plain"
        : callback === null
          ? "application/json;charset=UTF-8"
          : "application/javascript; charset=utf-8",
    ],
    ...(rejected ? [] : [["X-Cache", cache]]),
    ["Date", "<date>"],
    ["Connection", "close"],
    ["Transfer-Encoding", "chunked"],
  ]);
  if (rejected)
    expect(response.body).toEqual(Buffer.from("Invalid callback name", "utf8"));
  else expectRates(response, callback);
};

const commonDifferences = [
  "header content-length",
  "header content-type",
  "header etag",
  "header transfer-encoding",
];

/** Count and compare the exact request target, header lines/order, and body the socket received. */
const expectLedger = (business: Backend, sent: ReadonlyArray<Case>) =>
  Effect.gen(function* () {
    const ledger = yield* business.ledger;
    expect(ledger).toHaveLength(sent.length);
    expect(
      ledger.map((request) => ({
        method: request.method,
        target: request.target,
        lines: request.lines,
        body: Buffer.from(request.body),
      })),
    ).toEqual(
      sent.map((test) => ({
        method: "GET",
        target: test.target,
        lines: requestLines,
        body: Buffer.alloc(0),
      })),
    );
  });

describe("[PAY-1] the business API's JSONP against Express 5.3.0 res.jsonp", () => {
  for (const test of cases)
    it.live(
      `[PAY-1] express-jsonp/${test.name}: exact rates and frame, with the service's explicit header and callback policy`,
      () =>
        Effect.gen(function* () {
          expect(data("express-jsonp", "data.json")).toEqual(rates);
          const exchange = exchangeFor(test);
          // Fresh state avoids the deliberate path-only CDN cache. Seed equivalent recorded data
          // through envelopes.rates; the recorded request and rates-data bytes stay unadapted.
          const business = yield* lane.backend("business", {
            envelopes: { rates },
          });
          const actual = yield* send(business.origin, exchange.request);
          const [expected, got] = masked([exchange.response, actual], [date]);
          expectExpress(test, expected);
          expectBusiness(
            got,
            test.callback,
            test.rejected ? "rejected" : "MISS",
          );
          expect(differences(expected, got)).toEqual([
            ...(test.rejected ? ["status", "reason"] : []),
            ...commonDifferences,
            ...(test.rejected ? [] : ["header x-cache"]),
            "header x-content-type-options",
            "header x-powered-by",
            ...(test.rejected ? ["body"] : []),
          ]);
          if (!test.rejected) expect(got.body).toEqual(expected.body);
          yield* expectLedger(business, [test]);
        }).pipe(Effect.timeout("3 seconds")),
    );

  it.live(
    "[PAY-1] express-jsonp/cache: the second widget gets the first frame from the path-only CDN, unlike uncached Express",
    () =>
      Effect.gen(function* () {
        const show = cases.find((test) => test.name === "show-rates")!;
        const other = cases.find((test) => test.name === "other-widget")!;
        const first = exchangeFor(show);
        const second = exchangeFor(other);
        const business = yield* lane.backend("business", {
          envelopes: { rates },
        });
        const actualFirst = yield* send(business.origin, first.request);
        const actualSecond = yield* send(business.origin, second.request);
        const [expectedFirst, gotFirst] = masked(
          [first.response, actualFirst],
          [date],
        );
        const [expectedSecond, gotSecond] = masked(
          [second.response, actualSecond],
          [date],
        );
        expectExpress(show, expectedFirst);
        expectExpress(other, expectedSecond);
        expectBusiness(gotFirst, "showRates", "MISS");
        expectBusiness(gotSecond, "showRates", "HIT");
        expect(gotFirst.body).toEqual(expectedFirst.body);
        expect(gotSecond.body).toEqual(expectedFirst.body);
        expect(gotSecond.body).not.toEqual(expectedSecond.body);
        expect(differences(expectedFirst, gotFirst)).toEqual([
          ...commonDifferences,
          "header x-cache",
          "header x-content-type-options",
          "header x-powered-by",
        ]);
        expect(differences(expectedSecond, gotSecond)).toEqual([
          ...commonDifferences,
          "header x-cache",
          "header x-content-type-options",
          "header x-powered-by",
          "body",
        ]);
        yield* expectLedger(business, [show, other]);
      }).pipe(Effect.timeout("3 seconds")),
  );
});
