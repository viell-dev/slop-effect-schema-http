import assert from "node:assert/strict";
// #region imports
import { Context, DateTime, Effect, flow, Schema } from "effect";
import { HttpClientRequest } from "effect/http";
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

// #region plain-fields
const listAdmins = Request.get("https://api.example.test/users").pipe(
  Request.setQuery({ page: 2, role: ["admin", "owner"], preview: null }),
  Request.setHeader({ "accept-language": "en", "x-trace": () => "t1" }),
);
// ?page=2&role=admin&role=owner&preview
const seenSince = new Date("2026-11-01T00:00:00.000Z");
const recentAdmins = listAdmins.pipe(Request.setQuery({ since: seenSince }));
// The same, with &since=2026-11-01T00%3A00%3A00.000Z
// #endregion plain-fields
const admins = await Effect.runPromise(Request.compile(listAdmins, undefined));
assert.equal(
  admins.request.url,
  "https://api.example.test/users?page=2&role=admin&role=owner&preview",
);
assert.equal(
  (await Effect.runPromise(Request.compile(recentAdmins, undefined))).request
    .url,
  `${admins.request.url}&since=2026-11-01T00%3A00%3A00.000Z`,
);
assert.equal(admins.request.headers["x-trace"], "t1");

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

// #region extend-base
const toAdmin = (url: string) => `${url}/admin`;
const inAdmin = Request.mapBaseUrl(toAdmin);
const adminUsers = users.pipe(inAdmin);
// https://api.example.test/api/v1/admin/users
// #endregion extend-base
assert.equal(
  (await Effect.runPromise(Request.compile(adminUsers, undefined))).request.url,
  "https://api.example.test/api/v1/admin/users",
);

// #region discovered-base
class ApiHost extends Context.Service<ApiHost, string>()("app/ApiHost") {}

const discoveredApi = Effect.gen(function* () {
  const host = yield* ApiHost;
  return `https://${host}/api/v1`;
});
const onDiscoveredApi = Request.baseUrl(discoveredApi);
const listOrders = Request.get("/orders").pipe(onDiscoveredApi);
const listAdminOrders = listOrders.pipe(inAdmin);

const orders = await Effect.runPromise(
  Request.compile(listAdminOrders, undefined).pipe(
    Effect.provideService(ApiHost, "eu.example.test"),
  ),
);
// orders.request.url === "https://eu.example.test/api/v1/admin/orders"
// #endregion discovered-base
assert.equal(orders.request.url, "https://eu.example.test/api/v1/admin/orders");

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
const userId = Request.pathValue("userId", Schema.FiniteFromString);

const updateUser = Request.patch("").pipe(
  withApiDefaults,
  Request.path`/users/${userId}`,
  Request.body(Body.jsonSchema(Schema.Struct({ name: Schema.String }))),
);
const update = await Effect.runPromise(
  Request.compile(updateUser, { path: { userId: 42 }, body: { name: "Ada" } }),
);
// PATCH https://api.example.test/api/v1/users/42, JSON body { "name": "Ada" }
// #endregion inputs
assert.equal(update.request.url, "https://api.example.test/api/v1/users/42");
assert.equal(update.request.method, "PATCH");
assert.equal(update.request.headers["content-type"], "application/json");
assert.equal(update.request.headers["accept-language"], "en");

// #region nested-paths
const customer = Request.pathValue("customer");
const schedule = Request.pathValue("schedule");
const calendarId = Request.pathValue("calendar");
const eventId = Request.pathValue("event");

const atCalendar = Request.path`/customers/${customer}/schedules/${schedule}/calendars/${calendarId}`;
const atEvent = Request.path`/events/${eventId}`;

const getCalendar = Request.get("").pipe(withApiDefaults, atCalendar);
const getEvent = getCalendar.pipe(atEvent);
// #endregion nested-paths

// #region nested-input
const event = await Effect.runPromise(
  Request.compile(getEvent, {
    path: {
      customer: "customer-42",
      schedule: "work",
      calendar: "primary",
      event: "meeting/1",
    },
  }),
);
// https://api.example.test/api/v1/customers/customer-42/schedules/work/calendars/primary/events/meeting%2F1
// #endregion nested-input
const calendarInput = {
  path: { customer: "customer-42", schedule: "work", calendar: "primary" },
};
const calendar = await Effect.runPromise(
  Request.compile(getCalendar, calendarInput),
);
assert.equal(
  calendar.request.url,
  "https://api.example.test/api/v1/customers/customer-42/schedules/work/calendars/primary",
);
assert.equal(event.request.url, `${calendar.request.url}/events/meeting%2F1`);

// #region path-suffix
const thing = Request.pathValue("thing");

const getThing = Request.get("/things").pipe(api, Request.path`/${thing}`);
const archiveThing = Request.post("/things").pipe(
  api,
  Request.path`/${thing}:archive`,
);
const listThingParts = getThing.pipe(Request.path`/parts/`);
// /things/a%20b, /things/a%20b:archive and /things/a%20b/parts/ under the base
// #endregion path-suffix
const thingInput = { path: { thing: "a b" } };
assert.equal(
  (await Effect.runPromise(Request.compile(getThing, thingInput))).request.url,
  "https://api.example.test/api/v1/things/a%20b",
);
assert.equal(
  (await Effect.runPromise(Request.compile(archiveThing, thingInput))).request
    .url,
  "https://api.example.test/api/v1/things/a%20b:archive",
);
assert.equal(
  (await Effect.runPromise(Request.compile(listThingParts, thingInput))).request
    .url,
  "https://api.example.test/api/v1/things/a%20b/parts/",
);

// #region path-variant
const toLegacyPath = flow(
  Request.unbind("path"),
  Request.path`/legacy/calendars/${calendarId}`,
);
const getLegacyCalendar = toLegacyPath(getCalendar);
// Input: { path: { calendar: "primary" } }; /legacy/calendars/primary under the base

const atArchive = Request.setPath("/archive/things");
const getArchivedThing = getThing.pipe(atArchive);
// Input: { path: { thing: "a b" } }; /archive/things/a%20b under the base
// #endregion path-variant
assert.equal(
  (
    await Effect.runPromise(
      Request.compile(getLegacyCalendar, { path: { calendar: "primary" } }),
    )
  ).request.url,
  "https://api.example.test/api/v1/legacy/calendars/primary",
);
assert.equal(
  (await Effect.runPromise(Request.compile(getArchivedThing, thingInput)))
    .request.url,
  "https://api.example.test/api/v1/archive/things/a%20b",
);

// #region path-renderer
const folderPath = Request.path(Schema.String, (folder, encode) =>
  folder === "" ? "/" : `/${folder.split("/").map(encode).join("/")}/`,
);
const listFolder = Request.get("/files").pipe(api, folderPath);
// "" gives /files/, and "a b/c" gives /files/a%20b/c/ under the base
// #endregion path-renderer
assert.equal(
  (await Effect.runPromise(Request.compile(listFolder, { path: "" }))).request
    .url,
  "https://api.example.test/api/v1/files/",
);
assert.equal(
  (await Effect.runPromise(Request.compile(listFolder, { path: "a b/c" })))
    .request.url,
  "https://api.example.test/api/v1/files/a%20b/c/",
);

// #region path-constraint
const invoice = Request.pathValue(
  "invoice",
  Schema.TemplateLiteral(["inv-", Schema.Int]),
);
const getInvoice = Request.get("").pipe(
  api,
  Request.path`/invoices/${invoice}`,
);
// { path: { invoice: "inv-7" } } gives /invoices/inv-7 under the base
// { path: { invoice: ".." } } is a SchemaError, and nothing is sent
// #endregion path-constraint
assert.equal(
  (
    await Effect.runPromise(
      Request.compile(getInvoice, { path: { invoice: "inv-7" } }),
    )
  ).request.url,
  "https://api.example.test/api/v1/invoices/inv-7",
);
assert.equal(
  (
    await Effect.runPromise(
      Effect.flip(
        Request.compile(getInvoice, { path: { invoice: ".." as "inv-7" } }),
      ),
    )
  )._tag,
  "SchemaError",
);

// #region query
const search = Request.get("https://api.example.test/users").pipe(
  Request.query(Schema.Struct({ page: Schema.FiniteFromString })),
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

// #region dates
const Opening = Schema.Struct({
  from: Schema.Date,
  until: Schema.DateTimeUtcFromDate,
});
const listOpenings = Request.get("https://api.example.test/openings").pipe(
  Request.query(Opening),
);

const opening = await Effect.runPromise(
  Request.compile(listOpenings, {
    query: {
      from: new Date("2026-11-07T09:00:00.000Z"),
      until: DateTime.makeUnsafe("2026-11-07T17:00:00.000Z"),
    },
  }),
);
// ?from=2026-11-07T09%3A00%3A00.000Z&until=2026-11-07T17%3A00%3A00.000Z
// #endregion dates
assert.equal(
  opening.request.url,
  "https://api.example.test/openings?from=2026-11-07T09%3A00%3A00.000Z&until=2026-11-07T17%3A00%3A00.000Z",
);

// #region two-sides
const Slots = Schema.Struct({
  from: Schema.DateFromString,
  limit: Schema.FiniteFromString,
});
const listSlots = Request.get("https://api.example.test/slots").pipe(
  Request.query(Slots),
);
const noon = new Date("2026-11-07T12:00:00.000Z");

const decodedSide = { query: { from: noon, limit: 5 } };
const encodedSide = { query: { from: noon.toISOString(), limit: "5" } };
const mixed = { query: { from: noon, limit: "5" } };
// All three carry ?from=2026-11-07T12%3A00%3A00.000Z&limit=5
// #endregion two-sides
for (const input of [decodedSide, encodedSide, mixed]) {
  assert.equal(
    (await Effect.runPromise(Request.compile(listSlots, input))).request.url,
    "https://api.example.test/slots?from=2026-11-07T12%3A00%3A00.000Z&limit=5",
  );
}

// #region same-type
const Token = Schema.Struct({ token: Schema.StringFromBase64 });
const verify = Request.get("https://api.example.test/verify").pipe(
  Request.query(Token),
);

const decodedToken = { query: { token: "hello" } };
// ?token=aGVsbG8%3D
const encodedToken = { query: { token: "aGVsbG8=" } };
// ?token=YUdWc2JHOD0%3D, encoded twice
// #endregion same-type
assert.equal(
  (await Effect.runPromise(Request.compile(verify, decodedToken))).request.url,
  "https://api.example.test/verify?token=aGVsbG8%3D",
);
assert.equal(
  (await Effect.runPromise(Request.compile(verify, encodedToken))).request.url,
  "https://api.example.test/verify?token=YUdWc2JHOD0%3D",
);

// #region shape
const ApiHeaders = { authorization: Schema.optional(Schema.String) };
const Paging = Schema.Struct({
  limit: Schema.optional(Schema.FiniteFromString),
});
const Sorting = Schema.Struct({ sort: Schema.String });

const listThings = Request.get("https://api.example.test/things").pipe(
  Request.setHeader("authorization", "Bearer token"),
  Request.setQuery("limit", "25"),
  Request.headers(Schema.Struct({ ...ApiHeaders, "x-trace": Schema.String })),
  Request.query(Paging),
  Request.query(Sorting),
);
const listInput = { headers: { "x-trace": "t1" }, query: { sort: "name" } };
// ?limit=25&sort=name, with authorization and x-trace

const firstFive = listThings.pipe(Request.setQuery("limit", "5")); // Allowed, and checked
const noLimit = listThings.pipe(Request.removeQuery("limit")); // Allowed
const stray = listThings.pipe(Request.setQuery("fields", "id")); // InvalidRequest: no schema allows it
// #endregion shape
const urlOfList = async (request: typeof listThings) =>
  (await Effect.runPromise(Request.compile(request, listInput))).request.url;
assert.equal(
  await urlOfList(listThings),
  "https://api.example.test/things?limit=25&sort=name",
);
assert.equal(
  await urlOfList(firstFive),
  "https://api.example.test/things?limit=5&sort=name",
);
assert.equal(
  await urlOfList(noLimit),
  "https://api.example.test/things?sort=name",
);
assert.equal(
  (await Effect.runPromise(Effect.flip(Request.compile(stray, listInput))))
    ._tag,
  "InvalidRequest",
);

// #region unbind
const listByOwner = listThings.pipe(
  Request.unbind("query"),
  Request.removeQuery("limit"),
  Request.query(Schema.Struct({ owner: Schema.String })),
);
// Input: { headers: { "x-trace": "t1" }, query: { owner: "ada" } }; URL query: ?owner=ada
// #endregion unbind
assert.equal(
  (
    await Effect.runPromise(
      Request.compile(listByOwner, {
        headers: { "x-trace": "t1" },
        query: { owner: "ada" },
      }),
    )
  ).request.url,
  "https://api.example.test/things?owner=ada",
);

// #region map-effect
class Tenant extends Context.Service<Tenant, string>()("app/Tenant") {}

const addTenant = Request.mapEffect((native) =>
  Effect.gen(function* () {
    const tenant = yield* Tenant;
    return HttpClientRequest.setHeader(native, "x-tenant", tenant);
  }),
);

const tenantUsers = users.pipe(addTenant);
// Running this request now needs the Tenant service.
// #endregion map-effect
assert.equal(
  (
    await Effect.runPromise(
      Request.compile(tenantUsers, undefined).pipe(
        Effect.provideService(Tenant, "t1"),
      ),
    )
  ).request.headers["x-tenant"],
  "t1",
);

// #region adapt
const renameUser = updateUser.pipe(
  Request.mapInput((input: { id: number; name: string }) => ({
    path: { userId: input.id },
    body: { name: input.name },
  })),
);
const renamed = await Effect.runPromise(
  Request.compile(renameUser, { id: 42, name: "Grace" }),
);
// #endregion adapt
assert.equal(renamed.request.url, update.request.url);
