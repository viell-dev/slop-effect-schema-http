/**
 * EXT-6c: the gateway's old desktop path against httpd 2.4.69's `Redirect permanent`
 * (`recordings/httpd-redirect`). Node-only: the recordings are read from disk and compared with the
 * raw status and header lines the gateway sends.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import {
  date,
  differences,
  header,
  masked,
  recorded,
  send,
} from "./recordings.js";

/** The page's target, escaped as HTML. */
const escaped = (location: string) =>
  location.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

describe("[EXT-6c] the gateway's old desktop path against httpd 2.4.69's Redirect permanent", () => {
  for (const name of ["get", "post"])
    it.live(
      `[EXT-6c] ${name}: the same 301 and absolute Location, from the request's Host, under Apache 1.3's page`,
      () =>
        Effect.gen(function* () {
          const exchange = recorded("httpd-redirect", name);
          const gateway = yield* lane.backend("gateway", {});
          const actual = yield* send(gateway.origin, exchange.request);
          const [expected, got] = masked([exchange.response, actual], [date]);
          // Kept: the gateway is Apache 1.3, whose page and signature it writes
          // (services/gateway.md, "Recordings").
          expect(differences(expected, got)).toEqual([
            "header content-length",
            "header server",
            "body",
          ]);
          const [location] = header(got, "location");
          expect(location).toMatch(
            /^http:\/\/gateway\.example:8080\/cgi-bin\/report\.cgi\?session=/,
          );
          // Both pages link the target, escaped.
          expect(expected.body.toString("latin1")).toContain(
            `<a href="${escaped(location!)}">here</a>`,
          );
          expect(got.body.toString("latin1")).toContain(
            `<A HREF="${escaped(location!)}">here</A>`,
          );
        }),
    );
});
