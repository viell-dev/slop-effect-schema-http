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

/**
 * Whether Effect's decoder refuses a value with a `SchemaError`. A defect or an interruption fails
 * the test instead of passing as a refusal.
 */
export const refusesDecoding = <S extends Schema.Top>(
  schema: S,
  input: unknown,
) =>
  Effect.map(
    Effect.flip(Schema.decodeUnknownEffect(schema)(input)),
    (error) => error instanceof Schema.SchemaError,
  );

/**
 * A schema whose check refuses only under `onExcessProperty: "error"`, which no request uses. Effect
 * gives a parse's options to the schema's own steps, so only preparation's strict attempts see it
 * fail.
 */
export const strictOnlyCheck = <S extends Schema.Top>(
  message: string,
  schema: S,
) =>
  schema.check(
    Schema.makeFilter(
      (_value, _ast, options) =>
        options.onExcessProperty !== "error" || message,
    ),
  );

/** Whether Effect's constructor refuses a value with a schema issue, and nothing else. */
export const refusesConstruction = (schema: Schema.Top, input: unknown) =>
  Effect.map(Effect.flip(schema.makeEffect(input)), SchemaIssue.isIssue);

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

/**
 * A union whose first member a request reads field by field: a renamed field with a constructor
 * default, alone under `filter` or as the only item of `filters`, beside a value on each side, text a
 * codec rewrites, and an `Option` holding a key its schema does not state. `trace` records each
 * value the `left` and `gate` decoders read, each run of the default and each check of `right`.
 * `written` is what the member's encoded side holds once it is read.
 */
export const memberFieldwise = (list: boolean) => {
  const trace: Array<string> = [];
  const counted = (name: string) =>
    Schema.String.pipe(
      Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transform((text) => {
          trace.push(`${name}.read:${text}`);
          return text;
        }),
        encode: SchemaGetter.transform((text) => text),
      }),
      Schema.decodeTo(Schema.FiniteFromString),
    );
  const filter = Schema.Struct({
    limit: Schema.optionalKey(Schema.FiniteFromString).pipe(
      Schema.withConstructorDefault(
        Effect.sync(() => {
          trace.push("limit.default");
          return 25;
        }),
      ),
    ),
    gate: counted("gate"),
  }).pipe(Schema.encodeKeys({ limit: "page_size" }));
  const others = {
    left: counted("left"),
    right: Schema.FiniteFromString.check(
      Schema.makeFilter((value) => {
        trace.push(`right.check:${value}`);
        return true;
      }),
    ),
    shared: Schema.StringFromBase64,
    neighbor: Schema.Option(Schema.Struct({ keep: Schema.String })),
  };
  const schema = Schema.Union([
    Schema.Struct(
      list
        ? { filters: Schema.Array(filter), ...others }
        : { filter, ...others },
    ),
    Schema.Struct({ cursor: Schema.String }),
  ]);
  const given = { page_size: "08", gate: "02" };
  const kept = { page_size: "8", gate: "2" };
  const input = {
    ...(list ? { filters: [given] } : { filter: given }),
    left: "06",
    right: 4,
    shared: "eA==",
    neighbor: Option.some({ keep: "ok", stray: "strip" }),
  };
  const written = {
    ...(list ? { filters: [kept] } : { filter: kept }),
    left: "6",
    right: "4",
    shared: "ZUE9PQ==",
    neighbor: Option.some({ keep: "ok" }),
  };
  return { schema, input, written, trace };
};

/** What {@link memberFieldwise} records as a request prepares its input. */
export const memberFieldwiseTrace = [
  "gate.read:02",
  "left.read:06",
  "gate.read:02",
  "left.read:06",
  "gate.read:02",
  "left.read:06",
  "right.check:4",
  "limit.default",
  "gate.read:02",
  "left.read:06",
  "limit.default",
  "gate.read:02",
  "left.read:06",
  "limit.default",
  "gate.read:02",
  "gate.read:02",
  "left.read:06",
  "left.read:06",
  "right.check:4",
  "right.check:4",
  "right.check:4",
];
