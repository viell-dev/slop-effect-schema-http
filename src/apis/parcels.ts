/**
 * Parcels: a parcel-tracking API behind an edge proxy, written as a Warded route table.
 *
 * Its answers come from three layers, each with conventions of its own, as in a service that grew
 * in place: the application, the validation in front of it, and the edge proxy in front of both.
 * So one status can arrive in several shapes, and one response can carry lines that only make sense
 * separately. Every route and reply says which real-world convention it imitates. Names, ids and
 * data are synthetic.
 */
import {
  and,
  type Definition,
  exactPath,
  filter,
  get,
  lookupRoute,
  method,
  path,
  post,
  type Reply,
  route,
} from "../harness/routes.js";

type Lines = ReadonlyArray<readonly [string, string]>;

const json = (status: number, value: unknown, headers: Lines = []): Reply => ({
  status,
  headers: [["content-type", "application/json"], ...headers],
  body: JSON.stringify(value),
});

/** RFC 9457 problem details, whose `status` repeats the response's. */
const problem = (status: number, fields: Record<string, unknown>): Reply => ({
  status,
  headers: [["content-type", "application/problem+json"]],
  body: JSON.stringify({ ...fields, status }),
});

const text = (
  status: number,
  body: string,
  type = "text/plain; charset=utf-8",
  headers: Lines = [],
): Reply => ({ status, headers: [["content-type", type], ...headers], body });

/** The edge proxy's pages are HTML, whatever the client asked for. */
const page = (status: number, title: string, headers: Lines = []): Reply =>
  text(
    status,
    `<!doctype html><title>${title}</title><h1>${title}</h1>\n`,
    "text/html",
    headers,
  );

/** The parcels the application knows, as it answers them. */
export const knownParcels = {
  "1001": {
    id: "1001",
    state: "in_transit",
    events: [{ at: "2026-11-20T08:00:00Z", place: "Depot A" }],
  },
  "1002": {
    id: "1002",
    state: "delivered",
    events: [
      { at: "2026-11-20T08:00:00Z", place: "Depot A" },
      { at: "2026-11-21T15:30:00Z", place: "Door" },
    ],
  },
} as const;

/**
 * The `Set-Cookie` lines of a login, in the order the application writes them. A server writes
 * each cookie on its own line, since a comma cannot separate them: `Expires` holds one.
 */
export const sessionCookies = [
  // The session, out of reach of scripts.
  "sid=s-2; Path=/; Secure; HttpOnly; SameSite=Lax",
  // A CSRF token that scripts read and send back in a header, with an `Expires` date.
  "csrf=c-2; Path=/; Expires=Wed, 01 Dec 2027 08:00:00 GMT; Secure",
  // A migration that ends the retired v1 session: a cookie of the same name, on v1's path, cleared
  // by an `Expires` in the past. A browser keeps both cookies apart by their paths.
  "sid=; Path=/v1; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
] as const;

/**
 * The statuses the diagnostics route answers, each with the body that the layer which sends it in
 * the wild writes. Some services offer such a route so that client authors can test their handling;
 * this one also covers what a handler can send that no client should see.
 */
export const diagnostics: Readonly<Record<string, Reply>> = {
  // A handler that sends Continue, or Early Hints, as its final response: a mistake the Warded
  // Server turns into a 500, since no final response can be informational.
  "100": text(100, "continue"),
  "103": { status: 103, headers: [["link", "</app.css>; rel=preload"]] },
  "199": text(199, "the last informational status"),
  // Switching Protocols without an `Upgrade` field, from a handler that meant something else.
  "101": text(101, "switching"),
  // A 204 whose handler writes a debug body, which the server does not send.
  "204": json(204, { debug: "written by the handler" }),
  // Reset Content, whose handler writes a body too.
  "205": text(205, "reset"),
  // A Not Modified to a request that set no condition, with a body.
  "304": text(304, "not modified"),
  // An unregistered 2xx that an application uses for "accepted with warnings".
  "299": json(299, { warnings: ["partial"] }),
  // An unregistered 420 that some rate limiters send, with a delay in seconds.
  "420": text(420, "Enhance your calm", undefined, [["retry-after", "1"]]),
  // Too Many Requests, from the edge, with a delay in seconds.
  "429": text(429, "rate limited", undefined, [["retry-after", "1"]]),
  // A status that some proxies record for a client that went away, and some send.
  "499": text(499, "client closed request"),
  // An application fault with no content at all.
  "500": { status: 500 },
  // The edge's maintenance page.
  "503": page(503, "Down for maintenance", [["retry-after", "120"]]),
  // An edge proxy's unofficial 5xx for an origin answer that it could not read.
  "520": text(520, "unknown error from origin"),
  // The last status of the 5xx class, which some proxies send for a connect timeout.
  "599": text(599, "network connect timeout"),
  // The first status past the classes RFC 9110 defines.
  "600": text(600, "past the classes"),
  // The top of the three-digit range, which some sites send to clients they take for scrapers.
  "999": page(999, "Request denied"),
};

export const parcels: Definition = {
  routes: [
    // A login that answers JSON and sets its cookies on separate lines.
    route("session", and(post(), exactPath("/v2/session")), {
      ...json(200, { user: "user-1" }),
      headers: [
        ["content-type", "application/json"],
        ...sessionCookies.map((line) => ["set-cookie", line] as const),
      ],
    }),
    // The cache convention of an extension method, PURGE, to evict one object from the edge.
    route(
      "purge",
      and(method("PURGE"), path("/v2/parcels/{id}/cache")),
      json(200, { purged: true }),
    ),
    // Any other method there gets a 405 that names the one it takes, as RFC 9110 asks.
    route("cache-methods", path("/v2/parcels/{id}/cache"), {
      status: 405,
      headers: [["allow", "PURGE"]],
    }),
    // The application reads a parcel by its numeric id. An unknown id is its own JSON error, in
    // the nested shape of its error objects; a parcel past its retention is gone, in problem
    // details, since the application took that answer from the validation layer.
    lookupRoute(
      "parcel",
      and(get(), filter(path("/v2/parcels/{id}"), "id", "number")),
      {
        capture: "id",
        by: {
          ...Object.fromEntries(
            Object.entries(knownParcels).map(([id, parcel]) => [
              id,
              json(200, parcel),
            ]),
          ),
          "1410": problem(410, {
            type: "https://parcels.example/problems/expired",
            title: "Parcel record expired",
            detail: "Records are kept for 90 days after delivery.",
          }),
        },
        otherwise: json(404, {
          error: { code: "parcel_not_found", message: "No parcel has this id" },
        }),
      },
    ),
    // Validation: a refined capture routes first, and the rest are answered in problem details
    // with RFC 9457's `invalid-params` extension.
    route(
      "parcel-id",
      and(get(), path("/v2/parcels/{id}")),
      problem(422, {
        type: "https://parcels.example/problems/invalid-id",
        title: "Invalid parcel id",
        "invalid-params": [{ name: "id", reason: "must be a number" }],
      }),
    ),
    lookupRoute("diagnostics", and(get(), path("/v2/diagnostics/{code}")), {
      capture: "code",
      by: diagnostics,
      otherwise: problem(400, {
        type: "https://parcels.example/problems/unknown-status",
        title: "No diagnostic for this status",
      }),
    }),
  ],
  // The edge answers paths outside the API with its own HTML 404.
  fallback: { name: "edge-not-found", reply: page(404, "Not Found") },
};
