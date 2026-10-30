/**
 * EXT-6d: the business API's customer creation against Tomcat 7.0.109, recorded with its defaults
 * and with `useRelativeRedirects="false"` (`recordings/tomcat7-redirect`). Node-only: the
 * recordings are read from disk and compared with the raw status and header lines the backend
 * sends.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import type { Json } from "../harness/lane.js";
import {
  date,
  differences,
  header,
  masked,
  recorded,
  retarget,
  send,
} from "./recordings.js";

/** Four customers, so the second creation, the legacy container's, gets id 1006 as recorded. */
const four = {
  envelopes: {
    customers: [
      { id: 1001, name: "Northwind Traders", tier: "GOLD" },
      { id: 1002, name: "Contoso Pharmaceuticals", tier: "STANDARD" },
      { id: 1003, name: "Fabrikam Fibres", tier: "SILVER" },
      { id: 1004, name: "Tailspin Toys", tier: "STANDARD" },
    ],
  },
} satisfies Json;

/** A recorded Tomcat reply's status and Location. */
const location = (name: string) => {
  const { response } = recorded("tomcat7-redirect", name);
  return [response.status, header(response, "location")[0]];
};

/** The header lines every `/v1/` reply differs in from Tomcat's. */
const ENVELOPE = [
  // Kept: Node's server chunks a reply its backend gives no length; Tomcat counts one that fits
  // its buffer (recordings/README.md, "Comparing").
  "header content-length",
  // Kept: the firewall in front of `/v1/` removes Server (services/business.md, "Recordings").
  "header server",
  "header transfer-encoding",
  // Kept: the balancer names the container that answered.
  "header x-served-by",
];

describe("[EXT-6d] the business API's Location against Tomcat 7.0.109", () => {
  it.live(
    "[EXT-6d] header: app-1 answers as Tomcat does when the handler sets Location on a 200",
    () =>
      Effect.gen(function* () {
        const exchange = recorded("tomcat7-redirect", "header");
        const business = yield* lane.backend("business", {});
        const actual = yield* send(business.origin, exchange.request);
        const [expected, got] = masked([exchange.response, actual], [date]);
        expect(differences(expected, got)).toEqual(ENVELOPE);
        expect(header(got, "x-served-by")).toEqual(["app-1"]);
        expect(header(got, "location")).toEqual(["/v1/customers/1006"]);
      }),
  );

  it.live(
    "[EXT-6d] legacy-header: app-legacy-2 absolutizes the Location Tomcat leaves as set, in the form Tomcat's sendRedirect builds",
    () =>
      Effect.gen(function* () {
        const exchange = recorded("tomcat7-redirect", "legacy-header");
        const business = yield* lane.backend("business", four);
        // The first creation is app-1's; the second, compared, is app-legacy-2's. Adapted: the
        // recording's /legacy context prefix is removed from the target.
        const request = retarget(exchange.request, "/v1/customers");
        yield* send(business.origin, request);
        const actual = yield* send(business.origin, request);
        const [expected, got] = masked([exchange.response, actual], [date]);
        // Kept: Tomcat never rewrites a Location header, even with useRelativeRedirects="false";
        // the 2012 build absolutizes it itself (services/business.md, "Recordings").
        expect(differences(expected, got)).toEqual([
          "header content-length",
          "header location",
          "header server",
          "header transfer-encoding",
          "header x-served-by",
        ]);
        expect(header(expected, "location")).toEqual(["/v1/customers/1006"]);
        expect(header(got, "location")).toEqual(
          header(
            recorded("tomcat7-redirect", "legacy-redirect").response,
            "location",
          ),
        );
        expect(header(got, "x-served-by")).toEqual(["app-legacy-2"]);
      }),
  );

  it('[EXT-6d] Tomcat 7.0.109 absolutizes only sendRedirect\'s location, only with useRelativeRedirects="false", and keeps the 302', () => {
    expect(location("redirect")).toEqual([302, "/v1/customers/1006"]);
    expect(location("relative")).toEqual([302, "customers/1006"]);
    expect(location("redirect-then-200")).toEqual([302, "/v1/customers/1006"]);
    expect(location("legacy-redirect")).toEqual([
      302,
      "http://business.example:8080/v1/customers/1006",
    ]);
    expect(location("legacy-relative")).toEqual([
      302,
      "http://business.example:8080/legacy/v1/customers/1006",
    ]);
    expect(location("legacy-redirect-then-200")).toEqual([
      302,
      "http://business.example:8080/v1/customers/1006",
    ]);
    expect(location("legacy-header")).toEqual([200, "/v1/customers/1006"]);
  });
});
