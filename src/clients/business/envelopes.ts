import { Clock, Data, Duration, Effect, Schema } from "effect";
import {
  Body,
  Operation,
  Policy,
  Request,
  Response,
} from "viell-effect-schema-http";
import * as Dialect from "./envelopes-dialects.js";

/*
 * The consumer's contracts for the `/v1/` envelopes of the JSON business API. Everything here is
 * written against the library's public API and Effect, from what the API sends over HTTP; nothing is
 * shared with the backend.
 */

// ---------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------

const tiers = ["STANDARD", "SILVER", "GOLD", "PLATINUM"] as const;

/** A customer tier as the API accepts it in requests: its exact name. */
export const TierName = Schema.Literals(tiers);
export type Tier = typeof TierName.Type;

/** A customer tier as the API returns it: the enum's ordinal, decoded to the same name. */
export const TierOrdinal = Schema.Literals([0, 1, 2, 3]).transform(tiers);

export const CustomerId = Schema.Int.check(Schema.isGreaterThan(0));

export const Customer = Schema.Struct({
  id: CustomerId,
  name: Schema.String,
  tier: TierOrdinal,
  archived: Schema.Boolean,
});
export type Customer = typeof Customer.Type;

/** "Not found" arrives as a 200; only the body's `result` tells the outcomes apart. */
export const CustomerLookup = Schema.Union([
  Schema.Struct({ result: Schema.Literal("OK"), customer: Customer }),
  Schema.Struct({
    result: Schema.Literal("NOT_FOUND"),
    message: Schema.String,
  }),
]);
export type CustomerLookup = typeof CustomerLookup.Type;

/** The client refuses an empty name before any network; the server also refuses a blank one. */
export const NewCustomer = Schema.Struct({
  name: Schema.NonEmptyString,
  tier: TierName,
});

export const CustomerChanges = Schema.Struct({
  name: Schema.optionalKey(Schema.NonEmptyString),
  tier: Schema.optionalKey(TierName),
});

export const ValidationErrors = Schema.Struct({
  errors: Schema.Array(
    Schema.Struct({
      field: Schema.String,
      code: Schema.String,
      message: Schema.String,
    }),
  ),
});

export const Preferences = Schema.Struct({
  newsletter: Schema.Boolean,
  invoiceFormat: Schema.Literals(["EMAIL", "PDF", "PAPER"]),
});

const NotFoundError = Schema.Struct({ error: Schema.Literal("not_found") });

export const OrderLine = Schema.Struct({
  sku: Schema.NonEmptyString,
  quantity: Schema.Int.check(Schema.isGreaterThan(0)),
});

export const NewOrder = Schema.Struct({
  customerId: CustomerId,
  poNumber: Schema.NonEmptyString,
  lines: Schema.Array(OrderLine).check(Schema.isMinLength(1)),
});
export type NewOrder = typeof NewOrder.Type;

export const AcceptedOrder = Schema.Struct({
  orderId: Schema.String,
  status: Schema.Literal("ACCEPTED"),
  totalCents: Schema.Int,
});

export const OrderErrorCode = Schema.Literals([
  "MALFORMED_ORDER",
  "UNKNOWN_CUSTOMER",
  "CREDIT_HOLD",
  "UNKNOWN_SKU",
  "DUPLICATE_PO",
]);

/** The facts of a rejected order live in two headers; the body is the exception's text. */
export const OrderErrorHeaders = Schema.Struct({
  "x-error-code": OrderErrorCode,
  "x-error-message": Schema.String,
});

/** One batch item, discriminated by the status inside the always-200 envelope. */
export const BatchItem = Schema.Union([
  Schema.Struct({
    index: Schema.Int,
    status: Schema.Literal(201),
    order: AcceptedOrder,
  }),
  Schema.Struct({
    index: Schema.Int,
    status: Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 })),
    error: Schema.Struct({ code: OrderErrorCode, message: Schema.String }),
  }),
]);

export const BatchResult = Schema.Struct({
  batchId: Schema.String,
  results: Schema.Array(BatchItem),
});

const ExportState = Schema.Struct({
  exportId: Schema.Int,
  state: Schema.Literals(["QUEUED", "RUNNING"]),
});

export const ExportDone = Schema.Struct({
  exportId: Schema.Int,
  state: Schema.Literal("DONE"),
  rows: Schema.Array(
    Schema.Struct({ customerId: CustomerId, overdue30: Schema.Int }),
  ),
});

export const LedgerEntry = Schema.Struct({
  id: Dialect.ExactId,
  amountCents: Schema.Int,
  memo: Schema.String,
});

export const Ledger = Schema.Struct({
  account: Schema.String,
  entries: Schema.Array(LedgerEntry),
});

export const Regions = Schema.Struct({
  regions: Schema.Array(
    Schema.Struct({ code: Schema.String, name: Schema.String }),
  ),
});

export const Currencies = Schema.Struct({
  currencies: Schema.Array(
    Schema.Struct({ code: Schema.String, decimals: Schema.Int }),
  ),
});

/** An OData v2 verbose envelope: the `d` wrapper, per-entity metadata and a stringified count. */
export const ProductFeed = Schema.Struct({
  d: Schema.Struct({
    __count: Dialect.CountFromString,
    results: Schema.Array(
      Schema.Struct({
        __metadata: Schema.Struct({
          uri: Schema.String,
          type: Schema.Literal("Business.Product"),
        }),
        ProductID: Schema.Int,
        Name: Schema.String,
        UnitPrice: Schema.String.check(Schema.isPattern(/^\d+\.\d{4}$/)),
        Discontinued: Schema.Boolean,
      }),
    ),
  }),
});

export const Dashboard = Schema.Struct({
  openOrders: Schema.Int,
  creditHolds: Schema.Int,
});

export const Rates = Schema.Struct({
  base: Schema.String,
  rates: Schema.Record(Schema.String, Schema.String),
});

export const AgingRow = Schema.Struct({
  customerId: CustomerId,
  name: Schema.String,
  current: Schema.Int,
  overdue30: Schema.Int,
});

/** The documented column order of the aging report. */
export const agingColumns = [
  "customerId",
  "name",
  "current",
  "overdue30",
] as const;

export const AgingReport = Dialect.grid(AgingRow, agingColumns);

export const Warehouse = Schema.Struct({
  code: Schema.String,
  city: Schema.String,
});

/** The directory's bridge unwraps one warehouse and drops none; the domain always has a list. */
export const WarehouseDirectory = Schema.Struct({
  warehouses: Dialect.unwrappedList(Warehouse),
}).pipe(Schema.encodeKeys({ warehouses: "warehouse" }));

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const ListQuery = Schema.Struct({
  page: PositiveInt,
  perPage: PositiveInt,
  name: Schema.optionalKey(Schema.String),
}).pipe(Schema.encodeKeys({ perPage: "per_page" }));

/** The gateway's pagination links, converted to the listing's own one-based pages. */
export const ListHeaders = Schema.Struct({
  link: Dialect.pageLinks("/v1/customers"),
});

// ---------------------------------------------------------------------------------------------
// Decoders and outcomes
// ---------------------------------------------------------------------------------------------

/** A JSON body read as text and parsed by the given schema, whatever the content type claims. */
const textAs = <S extends Schema.Decoder<unknown>>(schema: S) =>
  Body.decoder(Body.text.pipe(Body.schema(schema)).decode, "application/json");

/** Decode a response's normalized headers with a schema. */
const headersAs = <S extends Schema.Decoder<unknown>>(schema: S) =>
  Schema.decodeUnknownEffect(schema);

const invalid = Body.jsonSchema(ValidationErrors).pipe(
  Body.map((value) => ({ _tag: "Invalid" as const, errors: value.errors })),
);

const missing = Body.jsonSchema(NotFoundError).pipe(
  Body.map(() => ({ _tag: "NotFound" as const })),
);

const CreatedHeaders = Schema.Struct({
  location: Schema.String,
  "x-served-by": Schema.String,
});

/** A 200 creation: an acknowledgement body and the new resource only in `Location`. */
const created = Body.decoder(
  (response) =>
    Effect.gen(function* () {
      yield* Body.jsonSchema(
        Schema.Struct({ success: Schema.Literal(true) }),
      ).decode(response);
      const headers = yield* headersAs(CreatedHeaders)(response.headers);
      const location = yield* Schema.decodeUnknownEffect(
        Dialect.locationAgainst(response.request.url),
      )(headers.location);
      return {
        _tag: "Created" as const,
        location,
        servedBy: headers["x-served-by"],
      };
    }),
  "application/json",
);

/** The delay a response asks for through `Retry-After`, read with the library's own helper. */
const retryAfter = (response: Parameters<typeof Response.metadata>[0]) =>
  Effect.map(Clock.currentTimeMillis, (now) =>
    Policy.retryAfterDelay(Response.metadata(response), now),
  );

const accepted = Body.decoder(
  (response) =>
    Effect.gen(function* () {
      const state = yield* Body.jsonSchema(ExportState).decode(response);
      const { location } = yield* headersAs(
        Schema.Struct({ location: Schema.String }),
      )(response.headers);
      return {
        exportId: state.exportId,
        monitor: yield* Schema.decodeUnknownEffect(
          Dialect.locationAgainst(response.request.url),
        )(location),
        retryAfter: yield* retryAfter(response),
      };
    }),
  "application/json",
);

const pending = Body.decoder(
  (response) =>
    Effect.gen(function* () {
      const state = yield* Body.jsonSchema(ExportState).decode(response);
      return {
        _tag: "Pending" as const,
        state: state.state,
        retryAfter: yield* retryAfter(response),
      };
    }),
  "application/json",
);

/** Polling ran out of attempts while the export still reported pending. */
export class ExportStillPending extends Data.TaggedError("ExportStillPending")<{
  readonly polls: number;
  readonly state: string;
}> {}

/** A customer could not be found, moved from the success envelope into the failure channel. */
export class CustomerNotFound extends Data.TaggedError("CustomerNotFound")<{
  readonly message: string;
}> {}

/** A final case for any response the contract does not model: read as text in the attempt's scope. */
export const readUnmodelled = Response.when(
  () => true,
  Body.decoder((response) =>
    Effect.map(response.text, (text) => ({
      _tag: "Unmodelled" as const,
      status: response.status,
      contentType: response.headers["content-type"],
      text,
    })),
  ),
);

/** A final case for any response the contract does not model: drained and discarded. */
export const discardUnmodelled = Response.when(
  () => true,
  Body.decoder((response) =>
    Effect.as(Body.empty.decode(response), {
      _tag: "Discarded" as const,
      status: response.status,
    }),
  ),
);

/** The header error rule: a 200 that carries `X-Error-Code`. It never needs the body. */
export const orderRejected = Response.when(
  (metadata) =>
    metadata.status === 200 && metadata.headers["x-error-code"] !== undefined,
  Body.decoder((response) =>
    Effect.map(headersAs(OrderErrorHeaders)(response.headers), (headers) => ({
      _tag: "Rejected" as const,
      code: headers["x-error-code"],
      message: headers["x-error-message"],
    })),
  ),
);

/** The plain 200 rule: an accepted order in the JSON body. */
export const orderAccepted = Response.status(
  200,
  Body.jsonSchema(AcceptedOrder).pipe(
    Body.map((order) => ({ _tag: "Accepted" as const, order })),
  ),
);

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

/** The `/v1/` contracts for a deployment at `origin`. Construction is pure. */
export const make = (origin: string) => {
  const base = `${origin}/v1`;
  const service = <I, E, R, H extends boolean, Q extends boolean>(
    request: Request.Request<I, E, R, H, Q>,
  ) => request.pipe(Request.baseUrl(base));
  const customerPath = (suffix = "") =>
    Request.path(
      CustomerId,
      (id, encode) => `customers/${encode(String(id))}${suffix}`,
    );
  /** A URL learned from a response, such as a resolved `Location`, used as the request target. */
  const at = Request.path(Schema.URLFromString, (href) => href);

  const lookup = Response.status(200, Body.jsonSchema(CustomerLookup));

  const requests = {
    createCustomer: Request.post("customers").pipe(
      Request.body(Body.jsonSchema(NewCustomer)),
      service,
    ),
    getCustomer: Request.get("customers/{id}").pipe(customerPath(), service),
    getCustomerAt: Request.get("{location}").pipe(at),
    listCustomers: Request.get("customers").pipe(
      Request.query(ListQuery),
      service,
    ),
    patchCustomer: Request.patch("customers/{id}").pipe(
      customerPath(),
      Request.body(Body.jsonSchema(CustomerChanges)),
      service,
    ),
    archiveCustomer: Request.post("customers/{id}/archive").pipe(
      customerPath("/archive"),
      service,
    ),
    savePreferences: Request.put("customers/{id}/preferences").pipe(
      customerPath("/preferences"),
      Request.body(Body.jsonSchema(Preferences)),
      service,
    ),
    getPreferences: Request.get("customers/{id}/preferences").pipe(
      customerPath("/preferences"),
      service,
    ),
    placeOrder: Request.post("orders").pipe(
      Request.body(Body.jsonSchema(NewOrder)),
      service,
    ),
    submitBatch: Request.post("orders/batch").pipe(
      Request.body(
        Body.jsonSchema(Schema.Struct({ orders: Schema.Array(NewOrder) })),
      ),
      service,
    ),
    startExport: Request.post("exports").pipe(
      Request.body(
        Body.jsonSchema(Schema.Struct({ report: Schema.Literal("aging") })),
      ),
      service,
    ),
    exportStatus: Request.get("{monitor}").pipe(at),
    ledger: Request.get("ledger").pipe(
      Request.query(Schema.Struct({ account: Schema.NonEmptyString })),
      service,
    ),
    ledgerEntry: Request.get("ledger/{id}").pipe(
      Request.path(
        Schema.BigInt,
        (id, encode) => `ledger/${encode(id.toString())}`,
      ),
      service,
    ),
    regions: Request.get("regions").pipe(service),
    currencies: Request.get("currencies").pipe(service),
    products: Request.get("odata/Products").pipe(
      Request.setQuery("$inlinecount", "allpages"),
      service,
    ),
    dashboard: Request.get("dashboard").pipe(service),
    rates: Request.get("rates").pipe(
      Request.query(Schema.Struct({ callback: Dialect.CallbackName })),
      service,
    ),
    agingReport: Request.get("reports/aging").pipe(
      Request.query(
        Schema.Struct({
          layout: Schema.optionalKey(Schema.Literals(["finance", "summary"])),
        }),
      ),
      service,
    ),
    warehouses: Request.get("warehouses").pipe(
      Request.query(Schema.Struct({ region: Schema.NonEmptyString })),
      service,
    ),
  };

  const responses = {
    createCustomer: Response.status(200, created).pipe(
      Response.orElse(Response.status(422, invalid)),
    ),
    lookup,
    listCustomers: Response.status(
      200,
      Body.decoder(
        (response) =>
          Effect.all({
            links: headersAs(ListHeaders)(response.headers),
            body: Body.jsonSchema(
              Schema.Struct({ customers: Schema.Array(Customer) }),
            ).decode(response),
          }).pipe(
            Effect.map(({ links, body }) => ({
              customers: body.customers,
              links: links.link,
            })),
          ),
        "application/json",
      ),
    ),
    /** The PATCH body predates the write, so it is drained unread. */
    patchCustomer: Response.status(
      200,
      Body.empty.pipe(Body.map(() => ({ _tag: "Applied" as const }))),
    ).pipe(Response.orElse(Response.status(422, invalid))),
    /** The 204 is declared empty, as it is on the wire. */
    archiveCustomer: Response.status(
      204,
      Body.empty.pipe(Body.map(() => ({ _tag: "Archived" as const }))),
    ).pipe(Response.orElse(Response.status(404, missing))),
    /** A 200 that claims JSON but carries zero bytes, declared empty. */
    savePreferences: Response.status(
      200,
      Body.empty.pipe(Body.map(() => ({ _tag: "Saved" as const }))),
    ).pipe(Response.orElse(Response.status(404, missing))),
    getPreferences: Response.status(200, Body.jsonSchema(Preferences)),
    /** The header rule first: declaration order is priority. */
    placeOrder: orderRejected.pipe(Response.orElse(orderAccepted)),
    submitBatch: Response.status(
      200,
      Body.jsonSchema(BatchResult).pipe(
        Body.map((batch) => ({
          batchId: batch.batchId,
          results: batch.results.map((item) =>
            "order" in item
              ? {
                  _tag: "Created" as const,
                  index: item.index,
                  order: item.order,
                }
              : {
                  _tag: "Failed" as const,
                  index: item.index,
                  status: item.status,
                  code: item.error.code,
                  message: item.error.message,
                },
          ),
        })),
      ),
    ),
    startExport: Response.status(202, accepted),
    exportStatus: Response.status(202, pending).pipe(
      Response.orElse(
        Response.status(
          200,
          Body.jsonSchema(ExportDone).pipe(
            Body.map((done) => ({ _tag: "Done" as const, rows: done.rows })),
          ),
        ),
      ),
    ),
    ledger: Response.status(200, textAs(Dialect.losslessJson(Ledger))),
    ledgerEntry: Response.status(
      200,
      textAs(Dialect.losslessJson(Schema.Struct({ entry: LedgerEntry }))),
    ),
    regions: Response.status(200, Body.jsonSchema(Regions)),
    currencies: Response.status(200, Body.jsonSchema(Currencies)),
    products: Response.status(200, Body.jsonSchema(ProductFeed)),
    dashboard: Response.status(
      200,
      textAs(
        Dialect.prefixed(")]}',\n").pipe(
          Schema.decodeTo(Schema.fromJsonString(Dashboard)),
        ),
      ),
    ),
    agingReport: Response.status(200, Body.json.pipe(Body.schema(AgingReport))),
    warehouses: Response.status(
      200,
      Body.json.pipe(Body.schema(WarehouseDirectory)),
    ),
  };

  /** JSONP: the expected callback flows from the input to the decoder of that one request. */
  const rates = Operation.fromEffect(
    (input: { readonly query: { readonly callback: string } }) =>
      Operation.make(
        requests.rates,
        Response.status(
          200,
          Body.decoder(
            Body.text.pipe(
              Body.schema(
                Dialect.jsonp(input.query.callback).pipe(
                  Schema.decodeTo(Schema.fromJsonString(Rates)),
                ),
              ),
            ).decode,
            "application/javascript",
          ),
        ),
      ).execute(input),
  );

  const getCustomer = Operation.make(requests.getCustomer, lookup);
  const patchCustomer = Operation.make(
    requests.patchCustomer,
    responses.patchCustomer,
  );
  const startExport = Operation.make(
    requests.startExport,
    responses.startExport,
  );
  const exportStatus = Operation.make(
    requests.exportStatus,
    responses.exportStatus,
  );

  /**
   * PATCH answers with the state before the write, so the update re-reads the customer and returns
   * what the GET says, never what the PATCH said.
   */
  const updateCustomer = Operation.fromEffect(
    (input: {
      readonly path: number;
      readonly body: typeof CustomerChanges.Type;
    }) =>
      Effect.gen(function* () {
        const outcome = yield* patchCustomer.execute(input);
        if (outcome._tag === "Invalid") return outcome;
        const lookup = yield* getCustomer.execute({ path: input.path });
        return { _tag: "Reread" as const, lookup };
      }),
  );

  /**
   * Poll an export's monitor until it is done. Polling is a loop over the same cold request: a 202
   * is a success whose state changes, not a failed attempt, so a retry policy is the wrong tool.
   * `pace` maps the delay the server asked for to the delay actually waited.
   */
  const awaitExport = (
    monitor: URL,
    options: {
      readonly firstDelay: Duration.Duration;
      readonly maxPolls: number;
      readonly pace?: (requested: Duration.Duration) => Duration.Duration;
    },
  ) =>
    Effect.gen(function* () {
      const pace =
        options.pace ?? ((requested: Duration.Duration) => requested);
      let delay = options.firstDelay;
      let state = "QUEUED";
      for (let poll = 1; poll <= options.maxPolls; poll++) {
        yield* Effect.sleep(pace(delay));
        const status = yield* exportStatus.execute({ path: monitor });
        if (status._tag === "Done") return { rows: status.rows, polls: poll };
        state = status.state;
        delay = status.retryAfter;
      }
      return yield* new ExportStillPending({ polls: options.maxPolls, state });
    });

  return {
    requests,
    responses,
    createCustomer: Operation.make(
      requests.createCustomer,
      responses.createCustomer,
    ),
    getCustomer,
    getCustomerAt: Operation.make(requests.getCustomerAt, lookup),
    /** A lookup whose "not found" envelope becomes a typed failure. */
    requireCustomer: getCustomer.pipe(
      Operation.mapEffect((found) =>
        found.result === "OK"
          ? Effect.succeed(found.customer)
          : Effect.fail(new CustomerNotFound({ message: found.message })),
      ),
    ),
    listCustomers: Operation.make(
      requests.listCustomers,
      responses.listCustomers,
    ),
    patchCustomer,
    updateCustomer,
    archiveCustomer: Operation.make(
      requests.archiveCustomer,
      responses.archiveCustomer,
    ),
    savePreferences: Operation.make(
      requests.savePreferences,
      responses.savePreferences,
    ),
    getPreferences: Operation.make(
      requests.getPreferences,
      responses.getPreferences,
    ),
    placeOrder: Operation.make(requests.placeOrder, responses.placeOrder),
    submitBatch: Operation.make(requests.submitBatch, responses.submitBatch),
    startExport,
    exportStatus,
    awaitExport,
    ledger: Operation.make(requests.ledger, responses.ledger),
    ledgerEntry: Operation.make(requests.ledgerEntry, responses.ledgerEntry),
    regions: Operation.make(requests.regions, responses.regions),
    currencies: Operation.make(requests.currencies, responses.currencies),
    products: Operation.make(requests.products, responses.products),
    dashboard: Operation.make(requests.dashboard, responses.dashboard),
    rates,
    agingReport: Operation.make(requests.agingReport, responses.agingReport),
    warehouses: Operation.make(requests.warehouses, responses.warehouses),
  };
};
