import { type Route, textReply } from "../../harness/route.js";
import {
  header,
  query,
  type Received,
  type Reply,
  text,
} from "../../harness/server.js";

/*
 * The `/v1/` half of the JSON business API. The backend is a black box: it shares no code with any
 * consumer and implements every wire format itself. Every route passes the firewall check first.
 *
 * Service documentation: services/business.md
 */

type Lines = ReadonlyArray<readonly [string, string]>;

/** The `envelopes` test options, documented under "Test options" in the service page. */
export interface Options {
  readonly customers?: ReadonlyArray<{
    readonly id: number;
    readonly name: string;
    readonly tier: string;
    readonly creditHold?: boolean;
  }>;
  readonly products?: ReadonlyArray<{
    readonly sku: string;
    readonly name: string;
    readonly priceCents: number;
    readonly discontinued?: boolean;
  }>;
  readonly ledger?: {
    readonly account: string;
    readonly entries: ReadonlyArray<{
      readonly id: string;
      readonly amountCents: number;
      readonly memo: string;
    }>;
  };
  readonly aging?: ReadonlyArray<{
    readonly customerId: number;
    readonly name: string;
    readonly current: number;
    readonly overdue30: number;
  }>;
  readonly warehouses?: Readonly<
    Record<
      string,
      ReadonlyArray<{ readonly code: string; readonly city: string }>
    >
  >;
  readonly regions?: ReadonlyArray<{
    readonly code: string;
    readonly name: string;
  }>;
  readonly currencies?: ReadonlyArray<{
    readonly code: string;
    readonly decimals: number;
  }>;
  readonly rates?: {
    readonly base: string;
    readonly rates: Readonly<Record<string, string>>;
  };
  readonly pendingPolls?: number;
}

const defaults: Required<Options> = {
  customers: [
    { id: 1001, name: "Northwind Traders", tier: "GOLD" },
    {
      id: 1002,
      name: "Contoso Pharmaceuticals",
      tier: "STANDARD",
      creditHold: true,
    },
    { id: 1003, name: "Fabrikam Fibres", tier: "SILVER" },
    { id: 1004, name: "Tailspin Toys", tier: "STANDARD" },
    { id: 1005, name: "Wide World Importers", tier: "PLATINUM" },
  ],
  products: [
    { sku: "WID-100", name: "Widget", priceCents: 1250 },
    { sku: "GAD-200", name: "Gadget", priceCents: 4999 },
    { sku: "SPR-300", name: "Sprocket", priceCents: 375, discontinued: true },
  ],
  ledger: {
    account: "4000",
    entries: [
      { id: "9007199254740992", amountCents: 125000, memo: "Opening balance" },
      { id: "9007199254740993", amountCents: -2500, memo: "Refund RMA-77" },
      { id: "9007199254740995", amountCents: 4999, memo: "Invoice INV-310" },
    ],
  },
  aging: [
    {
      customerId: 1001,
      name: "Northwind Traders",
      current: 120000,
      overdue30: 0,
    },
    {
      customerId: 1002,
      name: "Contoso Pharmaceuticals",
      current: 4500,
      overdue30: 98000,
    },
    { customerId: 1003, name: "Fabrikam Fibres", current: 0, overdue30: 1500 },
  ],
  warehouses: {
    EU: [
      { code: "AMS1", city: "Amsterdam" },
      { code: "FRA2", city: "Frankfurt" },
    ],
    APAC: [{ code: "SIN1", city: "Singapore" }],
    LATAM: [],
  },
  regions: [
    { code: "EU", name: "Europe" },
    { code: "APAC", name: "Asia Pacific" },
    { code: "LATAM", name: "Latin America" },
  ],
  currencies: [
    { code: "USD", decimals: 2 },
    { code: "EUR", decimals: 2 },
    { code: "JPY", decimals: 0 },
  ],
  rates: {
    base: "USD",
    rates: { EUR: "0.9150", GBP: "0.7890", JPY: "149.2000" },
  },
  pendingPolls: 2,
};

/** Jackson's default content type on the Spring stack, for every JSON reply but the exceptions. */
const springJson = "application/json;charset=UTF-8";

const reply = (status: number, value: unknown, lines: Lines = []): Reply =>
  textReply(status, JSON.stringify(value), springJson, lines);

/** Parse a request body as JSON; `undefined` when it is not JSON at all. */
const readJson = (request: Received): unknown => {
  try {
    return JSON.parse(text(request)) as unknown;
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const malformed = (): Reply =>
  reply(400, {
    errors: [
      {
        field: "",
        code: "malformed",
        message: "request body is not a JSON object",
      },
    ],
  });

/* Customer tiers in ordinal order: requests send names, responses the index. */
const tierNames = ["STANDARD", "SILVER", "GOLD", "PLATINUM"] as const;
type TierName = (typeof tierNames)[number];
const isTierName = (value: unknown): value is TierName =>
  typeof value === "string" &&
  (tierNames as ReadonlyArray<string>).includes(value);

interface CustomerRecord {
  readonly id: number;
  name: string;
  tier: TierName;
  archived: boolean;
  readonly creditHold: boolean;
  preferences: { newsletter: boolean; invoiceFormat: string };
}

const wire = (customer: CustomerRecord) => ({
  id: customer.id,
  name: customer.name,
  tier: tierNames.indexOf(customer.tier),
  archived: customer.archived,
});

const seedCustomers = (
  seeds: Required<Options>["customers"],
): Map<number, CustomerRecord> =>
  new Map(
    seeds.map((seed): [number, CustomerRecord] => {
      if (!isTierName(seed.tier))
        throw new Error(
          `fixture customer ${seed.id} has unknown tier ${seed.tier}`,
        );
      return [
        seed.id,
        {
          id: seed.id,
          name: seed.name,
          tier: seed.tier,
          archived: false,
          creditHold: seed.creditHold ?? false,
          preferences: { newsletter: false, invoiceFormat: "EMAIL" },
        },
      ];
    }),
  );

/* The customer controller's "not found" envelope, in a 200. */
const notFound = (id: number | string): Reply =>
  reply(200, {
    result: "NOT_FOUND",
    message: `Customer ${id} was not found`,
  });

/** Bean Validation messages as the 2016 validation layer renders them. */
const validateName = (
  value: unknown,
  required: boolean,
):
  | { readonly field: string; readonly code: string; readonly message: string }
  | undefined => {
  if (value === undefined)
    return required
      ? { field: "name", code: "missing", message: "must not be null" }
      : undefined;
  if (typeof value !== "string")
    return { field: "name", code: "type", message: "must be a string" };
  // `@NotBlank` trims before checking.
  if (value.trim() === "")
    return { field: "name", code: "blank", message: "must not be blank" };
  return undefined;
};

const validateTier = (value: unknown, required: boolean) => {
  if (value === undefined)
    return required
      ? { field: "tier", code: "missing", message: "must not be null" }
      : undefined;
  return isTierName(value)
    ? undefined
    : {
        field: "tier",
        code: "unknown_enum",
        message: `must be one of ${tierNames.join(", ")}`,
      };
};

const invalid = (
  errors: ReadonlyArray<
    | {
        readonly field: string;
        readonly code: string;
        readonly message: string;
      }
    | undefined
  >,
): Reply | undefined => {
  const present = errors.filter((error) => error !== undefined);
  return present.length === 0 ? undefined : reply(422, { errors: present });
};

/* The firewall's markup check over the decoded request target. */
const looksLikeMarkup = (target: string): boolean => {
  let decoded = target;
  try {
    decoded = decodeURIComponent(target.replaceAll("+", " "));
  } catch {
    // An undecodable target is inspected as sent.
  }
  return /[<>]/.test(decoded);
};

const firewallPage = (supportId: string): Reply =>
  textReply(
    403,
    "<html><head><title>Request Rejected</title></head><body>The requested URL was rejected. " +
      "Please consult with your administrator.<br><br>Your support ID is: " +
      `${supportId}<br><br><a href='javascript:history.back();'>[Go Back]</a></body></html>`,
    "text/html; charset=utf-8",
    [
      ["Cache-Control", "no-cache"],
      ["Connection", "close"],
    ],
  );

type OrderOutcome =
  | {
      readonly ok: true;
      readonly order: {
        readonly orderId: string;
        readonly status: "ACCEPTED";
        readonly totalCents: number;
      };
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
      readonly exception: string;
    };

const rejected = (
  status: number,
  code: string,
  exception: string,
  message: string,
): OrderOutcome => ({
  ok: false,
  status,
  code,
  message,
  exception: `com.example.orders.${exception}: ${message}`,
});

/** JSON with 64-bit integers written as exact digits, as the Java serializer does. */
const exactJson = (value: unknown): string =>
  JSON.stringify(value, (_, item: unknown) =>
    typeof item === "bigint" ? `\u0000${item.toString()}\u0000` : item,
  ).replace(/"\\u0000(-?\d+)\\u0000"/g, "$1");

/** Express's JSONP framing. */
const jsonpFrame = (callback: string, body: string): string =>
  `/**/ typeof ${callback} === 'function' && ${callback}(${body});`;

/* The aging report's saved column layouts. */
const agingLayouts: Readonly<Record<string, ReadonlyArray<string>>> = {
  default: ["customerId", "name", "current", "overdue30"],
  finance: ["customerId", "name", "overdue30", "current"],
  summary: ["customerId", "current", "overdue30"],
};

/** Edm.Decimal with four decimal places, as WCF Data Services renders it. */
const edmDecimal = (cents: number): string =>
  `${Math.trunc(cents / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}00`;

/** Routes of this part of the business API, with fresh state per call. */
export const routes = (options?: Options): ReadonlyArray<Route> => {
  const fixture: Required<Options> = { ...defaults, ...options };
  const customers = seedCustomers(fixture.customers);
  let nextCustomerId = Math.max(1000, ...customers.keys()) + 1;
  /* Products for orders, priced in integer cents. */
  const catalogue = new Map(
    fixture.products.map((product) => [product.sku, product] as const),
  );
  const ledgerEntries = fixture.ledger.entries.map((entry) => ({
    ...entry,
    id: BigInt(entry.id),
  }));
  const agingRows = fixture.aging;
  /* The 2015 throttle: the status checks of each export that report it pending. */
  const pendingPolls = fixture.pendingPolls;
  let creations = 0;
  const orders: Array<{
    readonly orderId: string;
    readonly customerId: number;
  }> = [];
  const purchaseOrders = new Set<string>();
  let nextOrder = 5001;
  let nextBatch = 9001;
  const exports = new Map<number, { readonly report: string; polls: number }>();
  let nextExport = 7001;
  let rateCache: Reply | undefined;
  let supportIds = 0n;

  const placeOrder = (value: unknown): OrderOutcome => {
    if (
      !isRecord(value) ||
      typeof value["customerId"] !== "number" ||
      typeof value["poNumber"] !== "string" ||
      !Array.isArray(value["lines"]) ||
      value["lines"].length === 0
    )
      return rejected(
        400,
        "MALFORMED_ORDER",
        "MalformedOrderException",
        "Order needs customerId, poNumber and at least one line",
      );
    const customerId = value["customerId"];
    const poNumber = value["poNumber"];
    const customer = customers.get(customerId);
    if (customer === undefined)
      return rejected(
        404,
        "UNKNOWN_CUSTOMER",
        "UnknownCustomerException",
        `Customer ${customerId} does not exist`,
      );
    if (customer.creditHold)
      return rejected(
        403,
        "CREDIT_HOLD",
        "CreditHoldException",
        `Customer ${customerId} is on credit hold`,
      );
    let totalCents = 0;
    for (const line of value["lines"] as ReadonlyArray<unknown>) {
      const sku = isRecord(line) ? line["sku"] : undefined;
      const quantity = isRecord(line) ? line["quantity"] : undefined;
      const product = typeof sku === "string" ? catalogue.get(sku) : undefined;
      if (product === undefined)
        return rejected(
          422,
          "UNKNOWN_SKU",
          "UnknownSkuException",
          `SKU ${String(sku)} is not in the catalogue`,
        );
      if (
        typeof quantity !== "number" ||
        !Number.isInteger(quantity) ||
        quantity < 1
      )
        return rejected(
          400,
          "MALFORMED_ORDER",
          "MalformedOrderException",
          `Quantity for ${String(sku)} must be a positive integer`,
        );
      totalCents += product.priceCents * quantity;
    }
    const key = `${customerId}/${poNumber}`;
    if (purchaseOrders.has(key))
      return rejected(
        409,
        "DUPLICATE_PO",
        "DuplicatePurchaseOrderException",
        `Purchase order ${poNumber} was already placed for customer ${customerId}`,
      );
    purchaseOrders.add(key);
    const orderId = `SO-${nextOrder++}`;
    orders.push({ orderId, customerId });
    return { ok: true, order: { orderId, status: "ACCEPTED", totalCents } };
  };

  const customerAt = (params: Readonly<Record<string, string>>) =>
    customers.get(Number(params["id"]));

  const all: ReadonlyArray<Route> = [
    /*
     * The balancer alternates between the two containers, starting with app-1. The legacy one
     * builds an absolute `Location` from the request's Host header; the other's path goes out as
     * written, because Node's http module never rewrites `Location`.
     */
    {
      method: "POST",
      path: "/v1/customers",
      handle: (request) => {
        const body = readJson(request);
        if (!isRecord(body)) return malformed();
        const rejection = invalid([
          validateName(body["name"], true),
          validateTier(body["tier"], true),
        ]);
        if (rejection !== undefined) return rejection;
        const id = nextCustomerId++;
        customers.set(id, {
          id,
          name: body["name"] as string,
          tier: body["tier"] as TierName,
          archived: false,
          creditHold: false,
          preferences: { newsletter: false, invoiceFormat: "EMAIL" },
        });
        const legacy = creations++ % 2 === 1;
        const path = `/v1/customers/${id}`;
        return reply(200, { success: true }, [
          [
            "Location",
            legacy
              ? `http://${header(request.lines, "host") ?? ""}${path}`
              : path,
          ],
          ["X-Served-By", legacy ? "app-legacy-2" : "app-1"],
        ]);
      },
    },
    /* The controller pages by `page`; the gateway plugin's `Link` speaks `offset` and `limit`. */
    {
      method: "GET",
      path: "/v1/customers",
      handle: (request) => {
        const parameters = query(request);
        const page = Number(parameters.get("page") ?? "1");
        const perPage = Number(parameters.get("per_page") ?? "2");
        if (
          !Number.isInteger(page) ||
          page < 1 ||
          !Number.isInteger(perPage) ||
          perPage < 1 ||
          perPage > 50
        )
          return reply(400, {
            errors: [
              {
                field: "page",
                code: "range",
                message: "page must be >= 1 and per_page between 1 and 50",
              },
            ],
          });
        const name = parameters.get("name")?.toLowerCase();
        const matching = Array.from(customers.values()).filter(
          (customer) =>
            name === undefined || customer.name.toLowerCase().includes(name),
        );
        const offset = (page - 1) * perPage;
        const lastOffset =
          Math.max(0, Math.ceil(matching.length / perPage) - 1) * perPage;
        const link = (rel: string, at: number) =>
          `</v1/customers?offset=${at}&limit=${perPage}>; rel="${rel}"`;
        const links = [link("first", 0)];
        if (offset > 0) links.push(link("prev", Math.max(0, offset - perPage)));
        if (offset + perPage < matching.length)
          links.push(link("next", offset + perPage));
        links.push(link("last", lastOffset));
        return reply(
          200,
          { customers: matching.slice(offset, offset + perPage).map(wire) },
          [["Link", links.join(", ")]],
        );
      },
    },
    {
      method: "GET",
      path: /^\/v1\/customers\/(?<id>\d+)$/,
      handle: (_, { params }) => {
        const customer = customerAt(params);
        return customer === undefined
          ? notFound(params["id"] ?? "")
          : reply(200, { result: "OK", customer: wire(customer) });
      },
    },
    /* PATCH serializes the customer before applying the changes. */
    {
      method: "PATCH",
      path: /^\/v1\/customers\/(?<id>\d+)$/,
      handle: (request, { params }) => {
        const customer = customerAt(params);
        if (customer === undefined) return notFound(params["id"] ?? "");
        const body = readJson(request);
        if (!isRecord(body)) return malformed();
        const rejection = invalid([
          validateName(body["name"], false),
          validateTier(body["tier"], false),
        ]);
        if (rejection !== undefined) return rejection;
        const before = wire(customer);
        if (typeof body["name"] === "string") customer.name = body["name"];
        if (isTierName(body["tier"])) customer.tier = body["tier"];
        return reply(200, { result: "OK", customer: before });
      },
    },
    /* The handler writes a debug body on its 204, which Node's http server drops. */
    {
      method: "POST",
      path: /^\/v1\/customers\/(?<id>\d+)\/archive$/,
      handle: (_, { params }) => {
        const customer = customerAt(params);
        if (customer === undefined)
          return reply(404, { error: "not_found", id: params["id"] });
        customer.archived = true;
        return {
          status: 204,
          lines: [["Content-Type", springJson]],
          body: JSON.stringify({
            debug: { node: "app-1", archived: customer.id, elapsedMs: 3 },
          }),
        };
      },
    },
    /* Saving preferences: a JSON content type over zero bytes. */
    {
      method: "PUT",
      path: /^\/v1\/customers\/(?<id>\d+)\/preferences$/,
      handle: (request, { params }) => {
        const customer = customerAt(params);
        if (customer === undefined)
          return reply(404, { error: "not_found", id: params["id"] });
        const body = readJson(request);
        if (
          !isRecord(body) ||
          typeof body["newsletter"] !== "boolean" ||
          typeof body["invoiceFormat"] !== "string"
        )
          return malformed();
        customer.preferences = {
          newsletter: body["newsletter"],
          invoiceFormat: body["invoiceFormat"],
        };
        return {
          status: 200,
          lines: [
            ["Content-Type", springJson],
            ["Content-Length", "0"],
          ],
        };
      },
    },
    {
      method: "GET",
      path: /^\/v1\/customers\/(?<id>\d+)\/preferences$/,
      handle: (_, { params }) => {
        const customer = customerAt(params);
        return customer === undefined
          ? reply(404, { error: "not_found", id: params["id"] })
          : reply(200, customer.preferences);
      },
    },
    /* Order placement: every outcome is a 200, failures in headers. */
    {
      method: "POST",
      path: "/v1/orders",
      handle: (request) => {
        const outcome = placeOrder(readJson(request));
        if (outcome.ok) return reply(200, outcome.order);
        return textReply(200, outcome.exception, springJson, [
          ["X-Error-Code", outcome.code],
          ["X-Error-Message", outcome.message],
        ]);
      },
    },
    /* The batch endpoint places each order as `/v1/orders` would and reports its status. */
    {
      method: "POST",
      path: "/v1/orders/batch",
      handle: (request) => {
        const body = readJson(request);
        if (!isRecord(body) || !Array.isArray(body["orders"]))
          return malformed();
        const results = (body["orders"] as ReadonlyArray<unknown>).map(
          (order, index) => {
            const outcome = placeOrder(order);
            return outcome.ok
              ? { index, status: 201, order: outcome.order }
              : {
                  index,
                  status: outcome.status,
                  error: { code: outcome.code, message: outcome.message },
                };
          },
        );
        return reply(200, { batchId: `B-${nextBatch++}`, results });
      },
    },
    {
      method: "POST",
      path: "/v1/exports",
      handle: (request) => {
        const body = readJson(request);
        if (!isRecord(body)) return malformed();
        if (body["report"] !== "aging")
          return reply(422, {
            errors: [
              { field: "report", code: "unknown", message: "unknown report" },
            ],
          });
        const id = nextExport++;
        exports.set(id, { report: "aging", polls: 0 });
        return reply(202, { exportId: id, state: "QUEUED" }, [
          ["Location", `exports/${id}`],
          ["Retry-After", "1"],
        ]);
      },
    },
    {
      method: "GET",
      path: /^\/v1\/exports\/(?<id>\d+)$/,
      handle: (_, { params }) => {
        const id = Number(params["id"]);
        const job = exports.get(id);
        if (job === undefined)
          return reply(404, { error: "not_found", id: params["id"] });
        job.polls++;
        if (job.polls <= pendingPolls)
          return reply(
            202,
            { exportId: id, state: job.polls === 1 ? "QUEUED" : "RUNNING" },
            [["Retry-After", "1"]],
          );
        return reply(200, {
          exportId: id,
          state: "DONE",
          rows: agingRows.map((row) => ({
            customerId: row.customerId,
            overdue30: row.overdue30,
          })),
        });
      },
    },
    {
      method: "GET",
      path: "/v1/ledger",
      handle: (request) => {
        const account = query(request).get("account");
        if (account !== fixture.ledger.account)
          return textReply(404, `{"error":"no such account"}`, springJson);
        return textReply(
          200,
          exactJson({ account, entries: ledgerEntries }),
          springJson,
        );
      },
    },
    {
      method: "GET",
      path: /^\/v1\/ledger\/(?<id>\d+)$/,
      handle: (_, { params }) => {
        const id = BigInt(params["id"] ?? "0");
        const entry = ledgerEntries.find((candidate) => candidate.id === id);
        return entry === undefined
          ? textReply(404, `{"error":"no such entry"}`, springJson)
          : textReply(200, exactJson({ entry }), springJson);
      },
    },
    {
      method: "GET",
      path: "/v1/regions",
      handle: () =>
        textReply(
          200,
          JSON.stringify({ regions: fixture.regions }),
          "text/html; charset=UTF-8",
        ),
    },
    {
      method: "GET",
      path: "/v1/currencies",
      handle: () =>
        textReply(
          200,
          JSON.stringify({ currencies: fixture.currencies }),
          "text/json; charset=utf-8",
        ),
    },
    /* The OData v2 facade, in verbose JSON. */
    {
      method: "GET",
      path: "/v1/odata/Products",
      handle: (request, { origin }) => {
        const parameters = query(request);
        const top = parameters.get("$top");
        const limit = top === null ? fixture.products.length : Number(top);
        if (!Number.isInteger(limit) || limit < 0)
          return textReply(
            400,
            JSON.stringify({
              error: {
                code: "",
                message: { lang: "en-US", value: "Invalid $top value." },
              },
            }),
            "application/json;odata=verbose;charset=utf-8",
          );
        const results = fixture.products
          .slice(0, limit)
          .map((product, index) => ({
            __metadata: {
              uri: `${origin}/v1/odata/Products(${index + 1})`,
              type: "Business.Product",
            },
            ProductID: index + 1,
            Name: product.name,
            UnitPrice: edmDecimal(product.priceCents),
            Discontinued: product.discontinued ?? false,
          }));
        const count =
          parameters.get("$inlinecount") === "allpages"
            ? { __count: String(fixture.products.length) }
            : {};
        return textReply(
          200,
          JSON.stringify({ d: { ...count, results } }),
          "application/json;odata=verbose;charset=utf-8",
          [["DataServiceVersion", "2.0;"]],
        );
      },
    },
    {
      method: "GET",
      path: "/v1/dashboard",
      handle: () =>
        textReply(
          200,
          `)]}',\n${JSON.stringify({
            openOrders: orders.length,
            creditHolds: Array.from(customers.values()).filter(
              (customer) => customer.creditHold,
            ).length,
          })}`,
          springJson,
        ),
    },
    /* The CDN's cache, keyed on the path alone, holds the first answer for the whole start. */
    {
      method: "GET",
      path: "/v1/rates",
      handle: (request) => {
        if (rateCache !== undefined)
          return {
            ...rateCache,
            lines: [...(rateCache.lines ?? []), ["X-Cache", "HIT"]],
          };
        const callback = query(request).get("callback");
        const payload = JSON.stringify(fixture.rates);
        let fresh: Reply;
        if (callback === null) fresh = textReply(200, payload, springJson);
        else if (!/^[A-Za-z_$][\w$]*$/.test(callback))
          return textReply(400, "Invalid callback name", "text/plain");
        else
          fresh = textReply(
            200,
            jsonpFrame(callback, payload),
            "application/javascript; charset=utf-8",
          );
        rateCache = fresh;
        return {
          ...fresh,
          lines: [...(fresh.lines ?? []), ["X-Cache", "MISS"]],
        };
      },
    },
    {
      method: "GET",
      path: "/v1/reports/aging",
      handle: (request) => {
        const layout = query(request).get("layout") ?? "default";
        const columns = agingLayouts[layout];
        if (columns === undefined)
          return reply(400, {
            errors: [
              { field: "layout", code: "unknown", message: "unknown layout" },
            ],
          });
        return reply(200, {
          columns,
          rows: agingRows.map((row) =>
            columns.map((column) => row[column as keyof typeof row]),
          ),
        });
      },
    },
    {
      method: "GET",
      path: "/v1/warehouses",
      handle: (request) => {
        const region = query(request).get("region");
        if (region === null)
          return reply(400, {
            errors: [
              { field: "region", code: "missing", message: "must not be null" },
            ],
          });
        // The XML-to-JSON bridge's unwrapping of one item and dropping of none.
        const found = fixture.warehouses[region] ?? [];
        return reply(
          200,
          found.length === 0
            ? {}
            : { warehouse: found.length === 1 ? found[0] : found },
        );
      },
    },
  ];

  return all.map((route): Route => ({
    ...route,
    handle: (request, context) =>
      looksLikeMarkup(request.target)
        ? firewallPage(String(7385419920601300000n + ++supportIds))
        : route.handle(request, context),
  }));
};
