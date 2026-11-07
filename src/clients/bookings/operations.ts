/**
 * The consumer's contract with Berth. Definitions hold no domain: a region is a value a caller
 * chooses, as a `baseUrl` here or later through the HTTP client, so one build can serve any
 * deployment. Each function makes the operation from a {@link Config}, and nothing here knows the
 * backend's code.
 */
import { Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  Body,
  Operation,
  type Policy,
  Request,
  Response,
  Transport,
} from "viell-effect-schema-http";
import {
  Availability,
  Booking,
  BookingDraft,
  BookingList,
  Health,
  Manifest,
  Problem,
  RepeatKey,
} from "./schemas.js";

export type Middleware = (
  client: HttpClient.HttpClient,
  attempt: number,
) => HttpClient.HttpClient;

export interface Config {
  /** The region to call. Without one, `transformClient` has to supply it. */
  readonly baseUrl?: string | undefined;
  readonly policy?: Policy.Policy | undefined;
  readonly transformClient?: Middleware | undefined;
}

const located =
  ({ baseUrl }: Config) =>
  <I, E, R>(request: Request.Request<I, E, R>): Request.Request<I, E, R> =>
    baseUrl === undefined ? request : request.pipe(Request.baseUrl(baseUrl));

const options = ({ policy, transformClient }: Config) => ({
  policy,
  transformClient,
});

/** Client middleware that puts a region in front of every URL, for a definition with no base. */
export const inRegion =
  (base: string) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    HttpClient.mapRequest(client, HttpClientRequest.prependUrl(base));

const bookingBody = Body.jsonSchema(Booking);
const problemBody = Body.jsonSchema(Problem);

/** `GET /v1/health`, which only Berth can answer with a {@link Health}. */
export const health = (config: Config = {}) =>
  Operation.make(
    Request.get("/v1/health").pipe(located(config)),
    Response.status(200, Body.jsonSchema(Health)),
    options(config),
  );

/** What a caller of {@link book} supplies: the booking, and a repeat key if it has one. */
export interface BookingInput {
  readonly draft: BookingDraft;
  readonly key?: string | undefined;
}

const committed = Response.status(
  201,
  Response.tag("Committed", bookingBody),
).pipe(
  Response.orElse(Response.status(200, Response.tag("Replayed", bookingBody))),
);

/**
 * `POST /v1/bookings`. A 201 and a 200 are the same booking, as the page says, and each case keeps
 * its metadata because `Location` and `Idempotent-Replay` are all that tells them apart on the wire.
 */
export const book = (config: Config = {}) =>
  Operation.make(
    Request.post("/v1/bookings").pipe(
      Request.headers(
        Schema.Struct({ "Idempotency-Key": Schema.optional(RepeatKey) }),
      ),
      Request.body(Body.jsonSchema(BookingDraft)),
      Request.mapInput(({ draft, key }: BookingInput) => ({
        headers: key === undefined ? {} : { "Idempotency-Key": key },
        body: draft,
      })),
      located(config),
    ),
    committed,
    options(config),
  );

/** {@link book} for a caller that can meet a key it used before, with another body. */
export const bookOrRefuse = (config: Config = {}) =>
  book(config).pipe(
    Operation.mapResponse(
      Response.orElse(
        Response.status(409, Response.tag("KeyReused", problemBody)),
      ),
    ),
  );

/** `GET /v1/bookings`, the region's own account of what it committed. */
export const bookings = (config: Config = {}) =>
  Operation.make(
    Request.get("/v1/bookings").pipe(located(config)),
    Response.status(200, Body.jsonSchema(BookingList)),
    options(config),
  );

const found = Response.status(200, Response.tag("Found", bookingBody)).pipe(
  Response.orElse(Response.status(404, Response.tag("Missing", problemBody))),
);

const bookingPath = Request.pathValue("id");

/** `GET /v1/bookings/<id>`. */
export const booking = (config: Config = {}) =>
  Operation.make(
    Request.get("/v1/bookings/").pipe(
      Request.path`${bookingPath}`,
      Request.mapInput((id: string) => ({ path: { id } })),
      located(config),
    ),
    found,
    options(config),
  );

const keyPath = Request.pathValue("key", RepeatKey);

/**
 * `GET /v1/keys/<key>`: how a client finds out what happened to a booking whose answer it lost. A
 * 404 says this region committed nothing under the key.
 */
export const keyed = (config: Config = {}) =>
  Operation.make(
    Request.get("/v1/keys/").pipe(
      Request.path`${keyPath}`,
      Request.mapInput((key: string) => ({ path: { key } })),
      located(config),
    ),
    found,
    options(config),
  );

/** `GET /v1/manifest`, read as text with no check of its own. */
export const manifest = (config: Config = {}) =>
  Operation.make(
    Request.get("/v1/manifest").pipe(located(config)),
    Response.status(200, Body.text),
    options(config),
  );

/** The manifest through the consumer's own check of its lines. */
export const checkedManifest = (config: Config = {}) =>
  Operation.make(
    Request.get("/v1/manifest").pipe(located(config)),
    Response.status(200, Body.text.pipe(Body.schema(Manifest))),
    options(config),
  );

const terminal = Request.query(
  Schema.Struct({ terminal: Schema.NonEmptyString }),
);

/** `GET /v1/availability?terminal=<name>`. A held terminal's answer stops half-way and waits. */
export const availability = (config: Config = {}) =>
  Operation.make(
    Request.get("/v1/availability").pipe(
      terminal,
      Request.mapInput((name: string) => ({ query: { terminal: name } })),
      located(config),
    ),
    Response.status(200, Body.jsonSchema(Availability)),
    options(config),
  );

/** `POST /v1/availability/release?terminal=<name>`: every waiting answer finishes. */
export const release = (config: Config = {}) =>
  Operation.make(
    Request.post("/v1/availability/release").pipe(
      terminal,
      Request.mapInput((name: string) => ({ query: { terminal: name } })),
      located(config),
    ),
    Response.status(204, Body.empty),
    options(config),
  );

const exportPath = Request.pathValue("name");

/** What an answer showed: every piece the library hands a decoder. */
export interface Read<A> {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly lines: Option.Option<Transport.Lines>;
  readonly value: A;
}

/** A decoder of any answer, keeping its metadata beside what `body` made of it. */
const read = <A, E, R>(
  body: Body.Decoder<A, E, R>,
): Body.Decoder<Read<A>, E, R> =>
  Body.decoder(
    (response) =>
      Effect.map(body.decode(response), (value) => ({
        status: response.status,
        headers: { ...response.headers },
        lines: Transport.responseHeaderLines(response),
        value,
      })),
    body.mediaType,
  );

/**
 * `GET /v1/export/<name>` with no opinion about the answer: any status, read by `body`. An export's
 * head is whatever a Perl job printed, so this is how a test sees what a client made of it.
 */
export const exportWith =
  <A, E, R>(body: Body.Decoder<A, E, R>) =>
  (config: Config = {}) =>
    Operation.make(
      Request.get("/v1/export/").pipe(
        Request.path`${exportPath}`,
        Request.mapInput((name: string) => ({ path: { name } })),
        located(config),
      ),
      Response.when(() => true, read(body)),
      options(config),
    );

/** An export as text. */
export const exported = exportWith(Body.text);
