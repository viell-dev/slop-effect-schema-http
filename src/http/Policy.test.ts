import { describe, expect, it } from "@effect/vitest";
import { Cause, Duration, Schedule } from "effect";
import { HttpClientError, HttpClientRequest } from "effect/http";
import { empty, response } from "../../test/support.js";
import * as Policy from "./Policy.js";
import * as Request from "./Request.js";
import * as Response from "./Response.js";

const request = HttpClientRequest.get("https://api.test/");

const metadata = (
  status: number,
  headers?: Record<string, string>,
): Response.Metadata => Response.metadata(response(empty(status, headers)));

const answered = (status: number): Policy.Reason => ({
  _tag: "Response",
  metadata: metadata(status),
});

const failed = (
  cause: Cause.Cause<unknown>,
  status?: number,
): Policy.Reason => ({
  _tag: "Failure",
  cause,
  metadata: status === undefined ? undefined : metadata(status),
});

const clientError = (
  reason: HttpClientError.HttpClientError["reason"],
): HttpClientError.HttpClientError =>
  new HttpClientError.HttpClientError({ reason });

const statusError = (status: number) =>
  clientError(
    new HttpClientError.StatusCodeError({
      request,
      response: response(empty(status)),
    }),
  );

describe("Policy.transient", () => {
  it.each([408, 429, 500, 502, 503, 504])(
    "classifies a %i response as transient",
    (status) => {
      expect(Policy.transient(answered(status))).toBe(true);
    },
  );

  it.each([200, 201, 204, 304, 400, 401, 404, 409, 420, 501, 505])(
    "classifies a %i response as final",
    (status) => {
      expect(Policy.transient(answered(status))).toBe(false);
    },
  );

  it("classifies a failure after a transient status as transient", () => {
    const decodeFailure = new Response.DecodeError({
      metadata: metadata(503),
      cause: "not json",
    });
    expect(Policy.transient(failed(Cause.fail(decodeFailure), 503))).toBe(true);
  });

  it("classifies an attempt timeout as transient", () => {
    expect(Policy.transient(failed(Cause.fail(new Cause.TimeoutError())))).toBe(
      true,
    );
  });

  it("classifies a transport failure as transient", () => {
    expect(
      Policy.transient(
        failed(
          Cause.fail(
            clientError(new HttpClientError.TransportError({ request })),
          ),
        ),
      ),
    ).toBe(true);
  });

  it("classifies middleware status rejections by their status", () => {
    expect(Policy.transient(failed(Cause.fail(statusError(503))))).toBe(true);
    expect(Policy.transient(failed(Cause.fail(statusError(404))))).toBe(false);
  });

  it("classifies other client errors as final", () => {
    expect(
      Policy.transient(
        failed(
          Cause.fail(
            clientError(
              new HttpClientError.InvalidUrlError({ request, cause: "bad" }),
            ),
          ),
        ),
      ),
    ).toBe(false);
  });

  it("classifies other typed failures, unexpected responses and decode failures as final", () => {
    expect(
      Policy.transient(
        failed(Cause.fail(new Request.InvalidRequest({ message: "x" }))),
      ),
    ).toBe(false);
    expect(
      Policy.transient(
        failed(
          Cause.fail(
            new Response.UnexpectedResponse({ metadata: metadata(404) }),
          ),
          404,
        ),
      ),
    ).toBe(false);
    expect(
      Policy.transient(
        failed(
          Cause.fail(
            new Response.DecodeError({ metadata: metadata(200), cause: "x" }),
          ),
          200,
        ),
      ),
    ).toBe(false);
  });

  it("does not classify defects or interruptions as transient", () => {
    expect(Policy.transient(failed(Cause.die(new Error("bug"))))).toBe(false);
    expect(Policy.transient(failed(Cause.interrupt()))).toBe(false);
  });

  it("classifies a cause as transient when any failure in it is transient", () => {
    const cause = Cause.combine(
      Cause.fail(new Request.InvalidRequest({ message: "x" })),
      Cause.fail(new Cause.TimeoutError()),
    );
    expect(Policy.transient(failed(cause))).toBe(true);
  });
});

/** The built-in classification plus an unregistered rate-limit status. */
const classify = (reason: Policy.Reason) =>
  Policy.transient(reason) || reason.metadata?.status === 420;

describe("Policy.make", () => {
  it("defaults to the transient classifier and honours Retry-After", () => {
    const schedule = Schedule.recurs(3);
    const policy = Policy.make(schedule);
    expect(policy.schedule).toBe(schedule);
    expect(policy.while).toBe(Policy.transient);
    expect(policy.retryAfter).toBe(true);
    expect(policy.attemptTimeout).toBeUndefined();
  });

  it("accepts a replacement classifier, attempt timeout, and Retry-After opt-out", () => {
    const policy = Policy.make(Schedule.recurs(1), {
      while: classify,
      attemptTimeout: "2 seconds",
      retryAfter: false,
    });
    expect(policy.while).toBe(classify);
    expect(policy.while(answered(420))).toBe(true);
    expect(policy.while(answered(503))).toBe(true);
    expect(policy.attemptTimeout).toBe("2 seconds");
    expect(policy.retryAfter).toBe(false);
  });

  it("treats explicitly undefined options as defaults", () => {
    const policy = Policy.make(Schedule.recurs(1), {
      while: undefined,
      retryAfter: undefined,
    });
    expect(policy.while).toBe(Policy.transient);
    expect(policy.retryAfter).toBe(true);
  });
});

describe("Policy.retryAfterDelay", () => {
  const now = Date.UTC(2026, 9, 29, 12, 0, 0);
  const delay = (value?: string) =>
    Duration.toMillis(
      Policy.retryAfterDelay(
        metadata(503, value === undefined ? {} : { "retry-after": value }),
        now,
      ),
    );

  it("requests no delay without the header", () => {
    expect(delay()).toBe(0);
  });

  it("reads delay seconds", () => {
    expect(delay("0")).toBe(0);
    expect(delay("120")).toBe(120_000);
  });

  it("reads an HTTP date relative to now", () => {
    expect(delay("Thu, 29 Oct 2026 12:00:30 GMT")).toBe(30_000);
  });

  it("requests no delay for an HTTP date in the past", () => {
    expect(delay("Thu, 29 Oct 2026 11:59:00 GMT")).toBe(0);
  });

  it("requests no delay for a delay too large to represent in milliseconds", () => {
    expect(delay("9".repeat(400))).toBe(0);
  });

  it.each(["soon", "-5", "1.5", "5, 10", ""])(
    "requests no delay for the malformed value %j",
    (value) => {
      expect(delay(value)).toBe(0);
    },
  );
});
