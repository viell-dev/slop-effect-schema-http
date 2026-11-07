import assert from "node:assert/strict";
import { Cause } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
// #region imports
import { Effect, Schedule } from "effect";
import {
  Body,
  Operation,
  Policy,
  Request,
  Response,
} from "viell-effect-schema-http";
// #endregion imports

// #region retry
const readPolicy = Policy.make(
  Schedule.recurs(2).pipe(
    Schedule.addDelay(() => Effect.succeed("100 millis")),
  ),
  { attemptTimeout: "5 seconds" },
);
const health = Operation.make(
  Request.get("https://api.example.test/health"),
  Response.status(200, Body.text),
  { policy: readPolicy },
);
// At most three attempts: the first attempt and two retries.
// #endregion retry

// #region timeout
const oneAttempt = Policy.make(Schedule.recurs(0), {
  attemptTimeout: "5 seconds",
});
const bounded = health.execute(undefined).pipe(Effect.timeout("12 seconds"));
// oneAttempt bounds a single attempt; bounded limits the whole evaluation.
// #endregion timeout
assert.ok(Effect.isEffect(bounded));
assert.equal(oneAttempt.attemptTimeout, "5 seconds");

// #region classification
const rateLimitsOnly = Policy.make(Schedule.recurs(2), {
  while: (reason) => reason.metadata?.status === 429,
});
// Retry only attempts with a visible 429 response. Other failures are final.
// #endregion classification
assert.equal(
  rateLimitsOnly.while({ _tag: "Failure", cause: Cause.empty }),
  false,
);

let attempts = 0;
const client = HttpClient.make((request) => {
  attempts++;
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new globalThis.Response(attempts < 3 ? "busy" : "ready", {
        status: attempts < 3 ? 503 : 200,
      }),
    ),
  );
});
assert.equal(
  await Effect.runPromise(
    health
      .execute(undefined)
      .pipe(Effect.provideService(HttpClient.HttpClient, client)),
  ),
  "ready",
);
assert.equal(attempts, 3);

// A completed 200 is an outcome the classifier sees, so this repeats it until the schedule ends,
// and the operation returns the last attempt's result.
let answers = 0;
const everyOutcome = Operation.make(
  Request.get("https://api.example.test/health"),
  Response.status(200, Body.text),
  { policy: Policy.make(Schedule.recurs(2), { while: () => true }) },
);
assert.equal(
  await Effect.runPromise(
    everyOutcome.execute(undefined).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          answers++;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new globalThis.Response(`answer ${answers}`),
            ),
          );
        }),
      ),
    ),
  ),
  "answer 3",
);
assert.equal(answers, 3);
