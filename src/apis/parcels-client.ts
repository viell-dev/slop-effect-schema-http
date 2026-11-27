/**
 * The parcels API as an application describes it with the library: the consumer side of
 * `parcels.ts`. It uses only the library's package root and Effect.
 */
import { Schema } from "effect";
import {
  Body,
  Operation,
  Policy,
  Request,
  Response,
} from "viell-effect-schema-http";
import { mediaType } from "./metadata.js";

export const Parcel = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["in_transit", "delivered"]),
  events: Schema.Array(
    Schema.Struct({ at: Schema.String, place: Schema.String }),
  ),
});

/** The application's own error objects. */
export const ErrorObject = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});

/** RFC 9457 problem details, with the `invalid-params` extension. */
export const Problem = Schema.Struct({
  type: Schema.String,
  title: Schema.String,
  status: Schema.Number,
  detail: Schema.optional(Schema.String),
  "invalid-params": Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, reason: Schema.String })),
  ),
});

/**
 * Every answer of a parcel read. A status alone does not say which layer answered, so each error
 * case also selects on the media type: 404 is the application's JSON for an unknown id, and the
 * edge's HTML for a path outside the API.
 */
export const parcelAnswers = Response.status(
  200,
  Response.tag("Parcel", Body.jsonSchema(Parcel)),
).pipe(
  Response.orElse(
    Response.when(
      (info) => mediaType(info) === "application/problem+json",
      Response.tag("Problem", Body.jsonSchema(Problem)),
      { key: "problem" },
    ),
  ),
  Response.orElse(
    Response.when(
      (info) => info.status === 404 && mediaType(info) === "application/json",
      Response.tag("NotFound", Body.jsonSchema(ErrorObject)),
      { key: "not-found" },
    ),
  ),
  Response.orElse(
    Response.when(
      (info) => mediaType(info) === "text/html",
      Response.tag("EdgePage", Body.text),
      { key: "edge" },
    ),
  ),
);

/**
 * The same answers selected by status alone, as a consumer would write them who read only the
 * application's documentation: a 404 is always the application's error object.
 */
export const byStatusAlone = Response.status(
  200,
  Response.tag("Parcel", Body.jsonSchema(Parcel)),
).pipe(
  Response.orElse(
    Response.status(
      404,
      Response.tag("NotFound", Body.jsonSchema(ErrorObject)),
    ),
  ),
  Response.orElse(Response.when(() => true, Response.tag("Other", Body.text))),
);

const id = Request.pathValue("id", Schema.String);

/** The base is relative, and the suite puts each listener's origin in front of it. */
export const parcel = Request.get("/parcels").pipe(
  Request.baseUrl("/v2"),
  Request.path`/${id}`,
);

export const getParcel = Operation.make(parcel, parcelAnswers);

/** Any answer, tagged with its metadata, for the statuses only some clients can represent. */
export const anyAnswer = Response.when(
  () => true,
  Response.tag("Answer", Body.text),
);

const code = Request.pathValue("code", Schema.String);

/** A diagnostic status. */
export const diagnostic = Request.get("/diagnostics").pipe(
  Request.baseUrl("/v2"),
  Request.path`/${code}`,
);

/**
 * Any answer to a diagnostic status, through a bounded attempt: a 101 can hand the connection
 * over, and a client that waits for the new protocol would otherwise hold the test.
 */
export const getDiagnostic = Operation.make(diagnostic, anyAnswer, {
  policy: Policy.timeout("5 seconds"),
});

/** A login, whose answer the application reads through its cookies. */
export const login = Operation.make(
  Request.post("/session").pipe(Request.baseUrl("/v2")),
  Response.status(
    200,
    Response.tag(
      "Session",
      Body.jsonSchema(Schema.Struct({ user: Schema.String })),
    ),
  ),
);

/** PURGE, the cache's extension method, with the 405 its route answers for any other. */
export const purgeAnswers = Response.status(
  200,
  Response.tag(
    "Purged",
    Body.jsonSchema(Schema.Struct({ purged: Schema.Boolean })),
  ),
).pipe(
  Response.orElse(Response.status(405, Response.tag("NotAllowed", Body.empty))),
);

export const cacheOf = (method: string) =>
  Operation.make(
    Request.make(method, "/parcels").pipe(
      Request.baseUrl("/v2"),
      Request.path`/${id}/cache`,
    ),
    purgeAnswers,
  );
