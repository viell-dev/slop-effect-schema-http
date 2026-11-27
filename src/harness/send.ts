import { expect } from "@effect/vitest";
import { type Duration, Effect, Exit, type Layer, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import type { Exchange, WireRequest } from "./evidence.js";
import type { Client, Listener } from "./lane.js";
import type { Table } from "./table.js";

/** What a route answers when its table gives it no reply. */
export const Routed = Schema.Struct({
  route: Schema.String,
  captures: Schema.Record(Schema.String, Schema.String),
});

/**
 * The response contract most scenarios use: the selection on 200, and any other answer as text.
 * Its JSON decoder makes the automatic `Accept` header `application/json`.
 */
export const answers = Response.status(
  200,
  Response.tag("Routed", Body.jsonSchema(Routed)),
).pipe(
  Response.orElse(Response.when(() => true, Response.tag("Other", Body.text))),
);

/** An operation with the usual contract, for a request with no base URL of its own. */
export const operation = <I, E, R>(request: Request.Request<I, E, R>) =>
  Operation.make(request, answers);

/** How an operation ended, in the terms its tests compare. */
export type Outcome =
  | {
      readonly kind: "routed";
      readonly route: string;
      readonly captures: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "answered";
      readonly status: number;
      readonly text: string;
    }
  /** A success of another contract than `answers`; `Sent.value` holds it. */
  | { readonly kind: "value" }
  | {
      readonly kind: "failure";
      readonly tag: string;
      readonly message: string;
    };

const tagOf = (error: unknown): string => {
  if (typeof error !== "object" || error === null) return String(error);
  const tagged = error as { _tag?: unknown; reason?: { _tag?: unknown } };
  const tag = typeof tagged._tag === "string" ? tagged._tag : "Error";
  return typeof tagged.reason?._tag === "string"
    ? `${tag}/${tagged.reason._tag}`
    : tag;
};

export const outcomeOf = (exit: Exit.Exit<unknown, unknown>): Outcome => {
  if (Exit.isFailure(exit)) {
    const error = Exit.findErrorOption(exit);
    const cause = error._tag === "Some" ? error.value : exit.cause;
    return {
      kind: "failure",
      tag: tagOf(cause),
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
  const value: unknown = exit.value;
  if (typeof value === "object" && value !== null && "_tag" in value) {
    const tagged = value as
      | { _tag: "Routed"; value: typeof Routed.Type }
      | { _tag: "Other"; value: string; metadata: Response.Metadata };
    if (tagged._tag === "Routed")
      return {
        kind: "routed",
        route: tagged.value.route,
        captures: tagged.value.captures,
      };
    if (tagged._tag === "Other")
      return {
        kind: "answered",
        status: tagged.metadata.status,
        text: tagged.value,
      };
  }
  return { kind: "value" };
};

export interface Sent<A = unknown> {
  readonly outcome: Outcome;
  /** The operation's own result, when it succeeded. */
  readonly value: A | undefined;
  /** Exchanges that reached the routes during this call. */
  readonly exchanges: ReadonlyArray<Exchange>;
  /** Request heads that crossed a cleartext listener during this call, without preflights. */
  readonly wire: ReadonlyArray<WireRequest>;
}

/**
 * Check what holds for every exchange whichever scenario sent it: dispatch ran the route that
 * `Router::select` chose, with the same captures, and a miss ran the fallback or nothing.
 */
const expectConsistent = (table: Table, exchange: Exchange) => {
  const { verdict, dispatched } = exchange;
  const context = JSON.stringify(exchange);
  if (verdict.is === "selected") {
    expect(dispatched?.index, context).toBe(verdict.index);
    expect(dispatched?.route, context).toBe(
      table.definition.routes[verdict.index]?.name,
    );
    expect(dispatched?.captures, context).toEqual(verdict.captures);
  } else if (verdict.is === "missed") {
    expect(dispatched?.route, context).toBe(table.definition.fallback?.name);
  } else {
    expect(dispatched, context).toBeNull();
  }
};

export interface Collecting {
  /**
   * Before taking the records, wait until the table's streamed replies have ended, for at most
   * this long, so that their progress says how each ended. A reply that is still open after it is
   * recorded as open.
   */
  readonly settle?: Duration.Input;
}

/**
 * Run an Effect that sends requests to a table, and collect what each side saw during it. Use it
 * for a request that names its own target, such as `*` or an absolute URL; `send` covers the rest.
 */
export const collect = <A, E, R>(
  table: Table,
  run: Effect.Effect<A, E, R>,
  { settle }: Collecting = {},
): Effect.Effect<Sent<A>, never, R> =>
  Effect.gen(function* () {
    // Leave out what earlier calls caused but did not take, such as a connection closing late.
    yield* table.take;
    const exit = yield* Effect.exit(run);
    if (settle !== undefined) yield* table.settle(settle);
    const taken = yield* table.take;
    const wire = taken.wire.filter((request) => !request.preflight);
    for (const exchange of taken.exchanges) expectConsistent(table, exchange);
    return {
      outcome: outcomeOf(exit),
      value: Exit.isSuccess(exit) ? exit.value : undefined,
      exchanges: taken.exchanges,
      wire,
    };
  });

/**
 * An operation's Effect against one of a table's listeners through a provider. The table's origin
 * goes in front of the operation's base URL, so a definition can keep a relative base such as
 * `/api/v1` or none at all. `send` runs it and collects the records; use it alone inside `collect`
 * to run it some other way, such as in a fiber that the test interrupts.
 */
export const execute = <I, A, E, R>(
  table: Table,
  listener: Listener,
  client: Client | Layer.Layer<HttpClient.HttpClient>,
  definition: Operation.Operation<I, A, E, R>,
  input: I,
): Effect.Effect<A, E, Exclude<R, HttpClient.HttpClient>> => {
  const layer = "layer" in client ? client.layer : client;
  const origin = table.origins[listener];
  // Every operation the scenarios send comes from `Operation.make`, which keeps its parts.
  const adjusted = Operation.mapRequest(
    Request.mapBaseUrl((base) => `${origin}${base}`),
  )(definition as never) as unknown as Operation.Operation<I, A, E, R>;
  return adjusted.execute(input).pipe(Effect.provide(layer)) as Effect.Effect<
    A,
    E,
    Exclude<R, HttpClient.HttpClient>
  >;
};

/** Run an operation as `execute` does, and collect what each side saw. */
export const send = <I, A, E, R>(
  table: Table,
  listener: Listener,
  client: Client | Layer.Layer<HttpClient.HttpClient>,
  definition: Operation.Operation<I, A, E, R>,
  input: I,
  collecting?: Collecting,
): Effect.Effect<Sent<A>, never, Exclude<R, HttpClient.HttpClient>> =>
  collect(
    table,
    execute(table, listener, client, definition, input),
    collecting,
  );

/** The one exchange of a call that should have made exactly one. */
export const only = (sent: Sent): Exchange => {
  expect(sent.exchanges, JSON.stringify(sent)).toHaveLength(1);
  return sent.exchanges[0]!;
};

/** One request of a call, as the routes saw and answered it. */
export interface Hop {
  readonly route: string;
  readonly path: string;
  readonly status: number;
  readonly method?: string;
  readonly query?: string;
  readonly captures?: Readonly<Record<string, string>>;
}

/**
 * Check every request a call made, in order: its request line on a cleartext wire, the head the
 * server saw, the route `select` chose with its captures, the handler that ran with the captures
 * the server decoded, and the status that handler answered.
 */
export const expectHops = (
  table: Table,
  sent: Sent,
  listener: Listener,
  hops: ReadonlyArray<Hop>,
): ReadonlyArray<Exchange> => {
  const context = JSON.stringify(sent);
  const line = ({ method = "GET", path, query }: Hop) => [
    method,
    query === undefined ? path : `${path}?${query}`,
  ];
  if (listener !== "https")
    expect(
      sent.wire.map((request) => [request.method, request.target]),
      context,
    ).toEqual(hops.map(line));
  expect(sent.exchanges, context).toHaveLength(hops.length);
  hops.forEach((hop, at) => {
    const { route, path, status, method = "GET", captures = {} } = hop;
    const exchange = sent.exchanges[at]!;
    expect(exchange.seen, context).toMatchObject({
      method,
      path,
      query: hop.query ?? null,
    });
    expect(exchange.verdict, context).toEqual({
      is: "selected",
      index: table.definition.routes.findIndex(
        (candidate) => candidate.name === route,
      ),
      captures,
    });
    expect(exchange.dispatched, context).toMatchObject({
      route,
      captures,
      params: { Ok: captures },
    });
    expect(exchange.status, context).toBe(status);
  });
  return sent.exchanges;
};
