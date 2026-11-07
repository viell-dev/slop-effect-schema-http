import assert from "node:assert/strict";
import { HttpClient, HttpClientResponse } from "effect/http";
// #region cases
import { Data, Effect, Schema } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";

const Problem = Schema.Struct({ detail: Schema.String });
const problem = Body.jsonSchema(Problem);

const apiErrors = Response.status(404, Response.tag("Missing", problem)).pipe(
  Response.orElse(Response.status(403, Response.tag("Forbidden", problem))),
);
const orApiError = Response.orElse(apiErrors);
// #endregion cases

// #region use
const Order = Schema.Struct({ id: Schema.Number, total: Schema.Number });
const Customer = Schema.Struct({ id: Schema.Number, name: Schema.String });

const api = Request.baseUrl("https://api.example.test/v1");
const orderId = Request.pathValue("orderId", Schema.FiniteFromString);
const customerId = Request.pathValue("customerId", Schema.FiniteFromString);

const getOrder = Operation.make(
  Request.get("").pipe(api, Request.path`/orders/${orderId}`),
  Response.status(200, Response.tag("Found", Body.jsonSchema(Order))).pipe(
    orApiError,
  ),
);
const getCustomer = Operation.make(
  Request.get("").pipe(api, Request.path`/customers/${customerId}`),
  Response.status(200, Response.tag("Found", Body.jsonSchema(Customer))).pipe(
    orApiError,
  ),
);
// #endregion use

// #region fail
class ApiProblem extends Data.TaggedError("ApiProblem")<{
  readonly kind: "Missing" | "Forbidden";
  readonly detail: string;
}> {}

const foundOrFail = <A>(
  outcome:
    | Response.Tagged<"Found", A>
    | Response.Tagged<"Missing", typeof Problem.Type>
    | Response.Tagged<"Forbidden", typeof Problem.Type>,
) =>
  outcome._tag === "Found"
    ? Effect.succeed(outcome.value)
    : Effect.fail(
        new ApiProblem({ kind: outcome._tag, detail: outcome.value.detail }),
      );

const requireOrder = getOrder.pipe(Operation.mapEffect(foundOrFail));
const requireCustomer = getCustomer.pipe(Operation.mapEffect(foundOrFail));
// #endregion fail

// #region drop
const noForbidden = Response.remove(403);

const publicOrder = requireOrder.pipe(Operation.mapResponse(noForbidden));
// #endregion drop

const answering = (status: number, body: unknown) =>
  Effect.provideService(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new globalThis.Response(JSON.stringify(body), { status }),
        ),
      ),
    ),
  );

assert.deepEqual(
  await Effect.runPromise(
    requireOrder
      .execute({ path: { orderId: 1 } })
      .pipe(answering(200, { id: 1, total: 5 })),
  ),
  { id: 1, total: 5 },
);
const forbidden = await Effect.runPromise(
  Effect.flip(requireCustomer.execute({ path: { customerId: 1 } })).pipe(
    answering(403, { detail: "not yours" }),
  ),
);
assert.ok(forbidden instanceof ApiProblem);
assert.equal(forbidden.kind, "Forbidden");
assert.equal(forbidden.detail, "not yours");

const tagged = await Effect.runPromise(
  getOrder
    .execute({ path: { orderId: 1 } })
    .pipe(answering(404, { detail: "no such order" })),
);
assert.equal(tagged._tag, "Missing");

// One operation can leave a shared case out, and the others keep it.
const unexpected = await Effect.runPromise(
  Effect.flip(publicOrder.execute({ path: { orderId: 1 } })).pipe(
    answering(403, { detail: "not yours" }),
  ),
);
assert.equal(unexpected._tag, "UnexpectedResponse");
