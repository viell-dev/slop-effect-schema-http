import { expect } from "@effect/vitest";
import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  Logger,
  Option,
  Schedule,
  Schema,
} from "effect";
import * as Body from "../src/http/Body.js";
import * as Operation from "../src/http/Operation.js";
import * as Policy from "../src/http/Policy.js";
import * as Request from "../src/http/Request.js";
import * as Response from "../src/http/Response.js";
import { type Exchange, json } from "./support.js";

export const failureOf = <E>(exit: Exit.Exit<unknown, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected a failure");
  const error = Cause.findErrorOption(exit.cause);
  if (Option.isNone(error)) throw new Error(`expected a typed failure`);
  return error.value;
};

/** Up to `retries` immediate retries. */
export const retries = (count: number) => Policy.make(Schedule.recurs(count));

export const getItem = Operation.make(
  Request.get("https://api.test/items/1"),
  Response.status(200, Body.json),
);

/** Read by client middleware on each attempt. */
export class Nonce extends Context.Service<Nonce, () => string>()(
  "test/Nonce",
) {}

interface LogRecord {
  readonly message: unknown;
  readonly level: string;
  readonly annotations: Record<string, unknown>;
  readonly spans: ReadonlyArray<string>;
  /** The complete record as JSON, including every annotation and span. */
  readonly json: string;
}

/** A logger that keeps each record in structured form. */
export const recording = () => {
  const records: Array<LogRecord> = [];
  const logger = Logger.make((options) => {
    const structured = Logger.formatStructured.log(options);
    records.push({
      message: structured.message,
      level: structured.level,
      annotations: structured.annotations,
      spans: Object.keys(structured.spans),
      json: Logger.formatJson.log(options),
    });
  });
  return { records, layer: Logger.layer([logger]) };
};

export const Thing = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  description: Schema.String,
});

export const ThingOption = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
});

export const Problem = Schema.Struct({
  title: Schema.String,
  detail: Schema.String,
});

export const pageOf = <S extends Schema.Top>(data: S) =>
  Schema.Struct({ data, page: Schema.Number, total: Schema.Number });

export const ThingPage = pageOf(Schema.Array(Thing));

export const OptionPage = pageOf(Schema.Array(ThingOption));

/** Needed by a mapping, to show a step's services. */
export class Audit extends Context.Service<
  Audit,
  { readonly record: (count: number) => Effect.Effect<void> }
>()("test/Audit") {}

export class NotFound extends Data.TaggedError("NotFound")<{
  readonly detail: string;
}> {}

export class ServerProblem extends Data.TaggedError("ServerProblem")<{
  readonly title: string;
}> {}

export const thing = (id: number) => ({
  id,
  name: `thing ${id}`,
  description: "synthetic",
});

export const option = (id: number) => ({ id, name: `thing ${id}` });

export const page = (data: ReadonlyArray<unknown>) => ({
  data,
  page: 1,
  total: data.length,
});

export const things = [thing(1), thing(2)];

export const reply = () => json(200, page(things));

export const gone = () => json(404, { title: "gone", detail: "no such thing" });

export const api = Request.baseUrl("https://api.example.test/v1");

export const firstFive = Request.setQuery("limit", "5");

export const withoutPaging = Request.removeQuery("page");

export const retryTwice = retries(2);

export const pagedThings = Operation.make(
  Request.get("/things?page=1&limit=25").pipe(api),
  Response.status(200, Body.jsonSchema(ThingPage)),
);

/** A definition that unwraps its envelope. */
export const getThings = pagedThings.pipe(Operation.map((value) => value.data));

export const found = Response.status(
  200,
  Response.tag("Found", Body.jsonSchema(ThingPage)),
);

export const missing = Response.status(
  404,
  Response.tag("Missing", Body.jsonSchema(Problem)),
);

const serverProblem = Response.when(
  (info) => info.status >= 500,
  Response.tag("Server", Body.jsonSchema(Problem)),
  { key: "server" },
);

export const contract = found.pipe(
  Response.orElse(missing),
  Response.orElse(serverProblem),
);

/** A definition that turns recognized outcomes into failures. */
export const search = Operation.make(
  Request.get("/search").pipe(api),
  contract,
).pipe(
  Operation.mapEffect((result) =>
    Effect.gen(function* () {
      switch (result._tag) {
        case "Found":
          return result.value.data;
        case "Missing":
          return yield* new NotFound({ detail: result.value.detail });
        case "Server":
          return yield* new ServerProblem({ title: result.value.title });
      }
    }),
  ),
);

export type Success<T> =
  T extends Operation.Operation<never, infer A, unknown, unknown> ? A : never;

export type Failures<T> =
  T extends Operation.Operation<never, unknown, infer E, unknown> ? E : never;

export type Services<T> =
  T extends Operation.Operation<never, unknown, unknown, infer R> ? R : never;

export const urlsOf = (provider: {
  readonly exchanges: ReadonlyArray<Exchange>;
}) => provider.exchanges.map((exchange) => exchange.url);

export const compileOnly = (
  statements: (...values: ReadonlyArray<never>) => void,
) => expect(statements).toBeTypeOf("function");
