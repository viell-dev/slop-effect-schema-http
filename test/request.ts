import {
  Context,
  Effect,
  Option,
  Schema,
  SchemaGetter,
  SchemaIssue,
} from "effect";
import * as Request from "../src/http/Request.js";
import * as UrlEncoding from "../src/http/UrlEncoding.js";
import { bodyText } from "./support.js";

/** A lone UTF-16 surrogate: a valid JavaScript string that cannot be percent-encoded. */
export const loneSurrogate = String.fromCharCode(0xd800);

export const compile = <I, E, R>(request: Request.Request<I, E, R>, input: I) =>
  Request.compile(request, input);

export const urlOf = <I, E, R>(request: Request.Request<I, E, R>, input: I) =>
  Effect.map(compile(request, input), (compiled) => compiled.request.url);

/** A compiled request's URL text and fragment, which are separate fields. */
export const targetOf = <I, E, R>(
  request: Request.Request<I, E, R>,
  input: I,
) =>
  Effect.map(compile(request, input), (compiled) => ({
    url: compiled.request.url,
    hash: Option.getOrUndefined(compiled.request.hash),
  }));

/** A binding that renders the fixed text `url` followed by the input. */
export const rendered = (url: string) =>
  Request.path(Schema.String, (value) => `${url}${value}`);

/** A literal passed to the result meets the input directly, so a stray key is an error too. */
export const takes =
  <S extends Schema.Top>(_schema: S) =>
  (_input: Request.Input<S>) =>
    undefined;

/** Read while encoding a header. */
export class Tenant extends Context.Service<Tenant, string>()("test/Tenant") {}

/** The `InvalidRequest` a request fails with. */
export const refusal = <I, E, R>(request: Request.Request<I, E, R>, input: I) =>
  Effect.flatMap(Effect.flip(compile(request, input)), (error) =>
    error instanceof Request.InvalidRequest
      ? Effect.succeed(error)
      : Effect.die(error),
  );

/** What a schema said about a caller's value, which comes before any group check. */
export const schemaFailure = <I, E, R>(
  request: Request.Request<I, E, R>,
  input: I,
) =>
  Effect.flatMap(Effect.flip(compile(request, input)), (error) =>
    error instanceof Schema.SchemaError
      ? Effect.succeed(error.message)
      : Effect.die(error),
  );

/** A request to `/x` with a query schema bound. */
export const queried = <
  S extends Schema.Top &
    Schema.ConstraintCodec<unknown, UrlEncoding.QueryInput, unknown, unknown>,
>(
  schema: S,
) => Request.get("/x").pipe(Request.query(schema));

/** A request to `/x` with two query schemas stacked, the first bound first. */
export const stacked = <
  F extends Schema.Top &
    Schema.ConstraintCodec<unknown, UrlEncoding.QueryInput, unknown, unknown>,
  G extends Schema.Top &
    Schema.ConstraintCodec<unknown, UrlEncoding.QueryInput, unknown, unknown>,
>(
  first: F,
  second: G,
) => Request.get("/x").pipe(Request.query(first), Request.query(second));

/** A compiled request's header lines. */
export const linesOf = <I, E, R>(request: Request.Request<I, E, R>, input: I) =>
  Effect.map(compile(request, input), (compiled) => compiled.headerLines);

/** A compiled request's body. */
export const bodyOf = <I, E>(request: Request.Request<I, E>, input: I) =>
  Effect.map(compile(request, input), ({ request: compiled }) =>
    bodyText(compiled),
  );

/** A time of day, which an application keeps as a value of its own. */
export class Moment {
  constructor(readonly minutes: number) {}
}

export const MomentFromSelf = Schema.declare(
  (input): input is Moment => input instanceof Moment,
);

export const notMoment = (input: string | number) =>
  Effect.fail(
    new SchemaIssue.InvalidValue({ message: `not a moment: ${input}` }),
  );

const twoDigits = (value: number) => String(value).padStart(2, "0");

/** Reads `t1530` and `15:30`, and always writes `15:30:00`. */
export const MomentFromString = Schema.String.pipe(
  Schema.decodeTo(MomentFromSelf, {
    decode: SchemaGetter.transformEffect((text: string) => {
      const match = /^t?(\d\d):?(\d\d)/i.exec(text);
      return match === null
        ? notMoment(text)
        : Effect.succeed(new Moment(Number(match[1]) * 60 + Number(match[2])));
    }),
    encode: SchemaGetter.transform(
      (moment: Moment) =>
        `${twoDigits(Math.floor(moment.minutes / 60))}:${twoDigits(moment.minutes % 60)}:00`,
    ),
  }),
);
