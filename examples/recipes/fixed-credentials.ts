import assert from "node:assert/strict";
import { HttpClientResponse } from "effect/http";
// #region credentials
import { Context, Data, Effect, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  Body,
  Operation,
  Policy,
  Request,
  Response,
} from "viell-effect-schema-http";

class CredentialsUnavailable extends Data.TaggedError(
  "CredentialsUnavailable",
) {}
class ApiCredentials extends Context.Service<
  ApiCredentials,
  { readonly current: Effect.Effect<string, CredentialsUnavailable> }
>()("app/ApiCredentials") {}

const authorize = (client: HttpClient.HttpClient) =>
  client.pipe(
    HttpClient.mapRequestEffect((request) =>
      Effect.gen(function* () {
        const token = yield* (yield* ApiCredentials).current;
        return HttpClientRequest.setHeader(
          request,
          "authorization",
          `Bearer ${token}`,
        );
      }),
    ),
  );
// #endregion credentials

// #region operation
const getStatus = Operation.make(
  Request.get("https://api.example.test/status").pipe(
    Request.headers(
      Schema.Struct({ "x-trace": Schema.optional(Schema.String) }),
    ),
  ),
  Response.status(200, Body.text),
  {
    transformClient: authorize,
    policy: Policy.make(Schedule.recurs(1)),
  },
);
// #endregion operation

// #region boundary
const readStatus = Operation.fromEffect(getStatus.execute);
// #endregion boundary

// #region run
const program = Effect.gen(function* () {
  return yield* readStatus.execute({ headers: { "x-trace": "t1" } });
});
// Provide HttpClient and ApiCredentials when running program.
// #endregion run

const sent: Array<{ token: string | undefined; trace: string | undefined }> =
  [];
const client = HttpClient.make((request) =>
  Effect.sync(() => {
    sent.push({
      token: request.headers.authorization,
      trace: request.headers["x-trace"],
    });
    const busy = sent.length === 1;
    return HttpClientResponse.fromWeb(
      request,
      new globalThis.Response(busy ? null : "ready", {
        status: busy ? 503 : 200,
      }),
    );
  }),
);
const provided = Effect.provideService(HttpClient.HttpClient, client);
let issued = 0;
const current = Effect.sync(() => `token-${++issued}`);
assert.equal(
  await Effect.runPromise(
    program.pipe(provided, Effect.provideService(ApiCredentials, { current })),
  ),
  "ready",
);
assert.deepEqual(sent, [
  { token: "Bearer token-1", trace: "t1" },
  { token: "Bearer token-2", trace: "t1" },
]);

const unavailable = await Effect.runPromise(
  Effect.flip(
    readStatus.execute({}).pipe(
      provided,
      Effect.provideService(ApiCredentials, {
        current: Effect.fail(new CredentialsUnavailable()),
      }),
    ),
  ),
);
assert.ok(unavailable instanceof CredentialsUnavailable);
assert.equal(sent.length, 2);
assert.equal("parts" in readStatus, false);

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const services: Same<
  Effect.Services<ReturnType<typeof readStatus.execute>>,
  ApiCredentials | HttpClient.HttpClient
> = true;
const credentialFailure: CredentialsUnavailable extends Effect.Error<
  ReturnType<typeof readStatus.execute>
>
  ? true
  : false = true;
const checkInput = () => {
  // @ts-expect-error: authorization is absent from the invocation's header schema.
  void readStatus.execute({ headers: { authorization: "Bearer caller" } });
  // @ts-expect-error: providing the HTTP client alone leaves ApiCredentials required.
  void Effect.runPromise(readStatus.execute({}).pipe(provided));
};
void services;
void credentialFailure;
void checkInput;
