import assert from "node:assert/strict";
// #region imports
import { Effect, flow, Schema } from "effect";
import { Body, Request } from "viell-effect-schema-http";
// #endregion imports

// #region simple
const listUsers = Request.get("https://api.example.test/users").pipe(
  Request.setQuery("limit", "10"),
  Request.setHeader("accept-language", "en"),
);
const compiled = await Effect.runPromise(Request.compile(listUsers, undefined));
// compiled.request.url === "https://api.example.test/users?limit=10"
// Nothing has been sent.
// #endregion simple
assert.equal(compiled.request.url, "https://api.example.test/users?limit=10");
assert.equal(compiled.request.headers["accept-language"], "en");

// #region shared-base
const api = Request.baseUrl("https://api.example.test/api/v1");
const users = Request.get("/users").pipe(api);
const teams = Request.get("/teams").pipe(api);
// https://api.example.test/api/v1/users
// https://api.example.test/api/v1/teams
// #endregion shared-base
assert.equal(
  (await Effect.runPromise(Request.compile(users, undefined))).request.url,
  "https://api.example.test/api/v1/users",
);
assert.equal(
  (await Effect.runPromise(Request.compile(teams, undefined))).request.url,
  "https://api.example.test/api/v1/teams",
);

// #region shared-defaults
const withApiDefaults = flow(Request.setHeader("accept-language", "en"), api);
const localizedUsers = Request.get("/users").pipe(withApiDefaults);
const frenchUsers = localizedUsers.pipe(
  Request.setHeader("accept-language", "fr"),
);
// localizedUsers still uses "en"; frenchUsers uses "fr".
// #endregion shared-defaults
assert.equal(
  (await Effect.runPromise(Request.compile(localizedUsers, undefined))).request
    .headers["accept-language"],
  "en",
);
assert.equal(
  (await Effect.runPromise(Request.compile(frenchUsers, undefined))).request
    .headers["accept-language"],
  "fr",
);

// #region inputs
const updateUser = Request.patch("").pipe(
  withApiDefaults,
  Request.path(Schema.NumberFromString, (id, encode) => `/users/${encode(id)}`),
  Request.body(Body.jsonSchema(Schema.Struct({ name: Schema.String }))),
);
const update = await Effect.runPromise(
  Request.compile(updateUser, { path: 42, body: { name: "Ada" } }),
);
// PATCH https://api.example.test/api/v1/users/42, JSON body { "name": "Ada" }
// #endregion inputs
assert.equal(update.request.url, "https://api.example.test/api/v1/users/42");
assert.equal(update.request.method, "PATCH");
assert.equal(update.request.headers["content-type"], "application/json");
assert.equal(update.request.headers["accept-language"], "en");

// #region nested-paths
const CalendarPath = Schema.Struct({
  customer: Schema.String,
  user: Schema.String,
  schedule: Schema.String,
  calendar: Schema.String,
});
const EventPath = Schema.Struct({
  ...CalendarPath.fields,
  event: Schema.String,
});

const calendarPath = (
  ids: typeof CalendarPath.Encoded,
  encode: (value: string) => string,
) =>
  `/end-customers/${encode(ids.customer)}/users/${encode(ids.user)}` +
  `/schedules/${encode(ids.schedule)}/calendars/${encode(ids.calendar)}`;

const getCalendar = Request.get("").pipe(
  withApiDefaults,
  Request.path(CalendarPath, calendarPath),
);
const getEvent = Request.get("").pipe(
  withApiDefaults,
  Request.path(
    EventPath,
    (ids, encode) => `${calendarPath(ids, encode)}/events/${encode(ids.event)}`,
  ),
);
// #endregion nested-paths

// #region nested-input
const event = await Effect.runPromise(
  Request.compile(getEvent, {
    path: {
      customer: "customer-42",
      user: "user-7",
      schedule: "work",
      calendar: "primary",
      event: "meeting/1",
    },
  }),
);
// https://api.example.test/api/v1/end-customers/customer-42/users/user-7/schedules/work/calendars/primary/events/meeting%2F1
// #endregion nested-input
const calendar = await Effect.runPromise(
  Request.compile(getCalendar, {
    path: {
      customer: "customer-42",
      user: "user-7",
      schedule: "work",
      calendar: "primary",
    },
  }),
);
assert.equal(
  calendar.request.url,
  "https://api.example.test/api/v1/end-customers/customer-42/users/user-7/schedules/work/calendars/primary",
);
assert.equal(event.request.url, `${calendar.request.url}/events/meeting%2F1`);

// #region query
const search = Request.get("https://api.example.test/users").pipe(
  Request.query(Schema.Struct({ page: Schema.NumberFromString })),
  Request.headers(Schema.Struct({ "accept-language": Schema.String })),
);
const page = await Effect.runPromise(
  Request.compile(search, {
    query: { page: 2 },
    headers: { "accept-language": "en" },
  }),
);
// page.request.url === "https://api.example.test/users?page=2"
// #endregion query
assert.equal(page.request.url, "https://api.example.test/users?page=2");

// #region adapt
const renameUser = updateUser.pipe(
  Request.mapInput((input: { id: number; name: string }) => ({
    path: input.id,
    body: { name: input.name },
  })),
);
const renamed = await Effect.runPromise(
  Request.compile(renameUser, { id: 42, name: "Grace" }),
);
// #endregion adapt
assert.equal(renamed.request.url, update.request.url);
