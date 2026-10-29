/**
 * The `/v2/` half of the JSON business API: the service's routes behind `front`, which plays the
 * API gateway (merged slashes, the method allowlist and the override tunnel), with `viaEdge` as the
 * edge cache in front of the catalogue. It imports only Node built-ins and the harness, and formats
 * and parses every value convention with its own code. Options are merged over {@link defaults}.
 *
 * Service documentation: services/business.md
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { json, router, type Route } from "../../harness/route.js";
import {
  type Context,
  header,
  headerValues,
  type Lines,
  type Received,
  type Reply,
} from "../../harness/server.js";

/** An instant in an ASP.NET date: UTC milliseconds and the decorative offset, if any. */
export interface DotNetDate {
  readonly epochMillis: number;
  /** Minutes east of UTC, written as `±hhmm`; `null` writes no offset. */
  readonly offsetMinutes: number | null;
}

export interface TaskSeed {
  readonly title: string;
  readonly assigneeId: string;
  readonly priority: number;
  readonly due: DotNetDate | null;
  readonly notes: string | null;
  readonly done: boolean;
  readonly created: number;
}

export interface CustomerSeed {
  readonly id: number;
  readonly name: string;
  readonly country: string;
}

/** A wall-clock reading as the branch office's printer recorded it, without a zone. */
export interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export interface InvoiceSeed {
  readonly id: number;
  readonly customerId: number;
  readonly amountCents: number;
  readonly paid: boolean;
  readonly issued: number;
  readonly due: DotNetDate;
  readonly printed: WallClock;
  readonly tags: ReadonlyArray<string>;
  readonly poNumber?: string | null;
  readonly seatLimit: number | "unlimited";
}

export interface PriceSeed {
  readonly sku: string;
  readonly cents: number;
}

/** The `operations` test options, documented under "Test options" in the service page. */
export interface Options {
  readonly token?: string;
  readonly searchLatency?: Readonly<Record<string, number>>;
  readonly longPollHold?: number;
  readonly clock?: number | null;
  readonly tasks?: ReadonlyArray<TaskSeed>;
  readonly customers?: ReadonlyArray<CustomerSeed>;
  readonly invoices?: ReadonlyArray<InvoiceSeed>;
  readonly invoicesModified?: number;
  readonly catalog?: {
    readonly prices: ReadonlyArray<PriceSeed>;
    readonly stale: ReadonlyArray<PriceSeed>;
  };
}

export const defaults: Required<Options> = {
  token: "ops-token-2016",
  searchLatency: {},
  longPollHold: 25_000,
  clock: null,
  tasks: [
    {
      title: "Reconcile the October ledger",
      assigneeId: "u-ada",
      priority: 2,
      due: { epochMillis: 1_701_388_800_000, offsetMinutes: 0 },
      notes: null,
      done: false,
      created: 1_698_796_800_000,
    },
    {
      title: "Archive the September exports",
      assigneeId: "u-grace",
      priority: 4,
      due: null,
      notes: "Moved to cold storage",
      done: true,
      created: 1_696_118_400_000,
    },
  ],
  customers: [{ id: 7, name: "Acme Corporation", country: "US" }],
  invoices: [
    {
      id: 1,
      customerId: 7,
      amountCents: 1_999,
      paid: false,
      issued: 1_700_000_000_000,
      due: { epochMillis: 1_702_592_000_000, offsetMinutes: -300 },
      printed: {
        year: 2023,
        month: 11,
        day: 14,
        hour: 17,
        minute: 13,
        second: 20,
      },
      tags: ["new"],
      poNumber: null,
      seatLimit: "unlimited",
    },
  ],
  invoicesModified: 1_700_000_000_000,
  catalog: {
    prices: [{ sku: "A-100", cents: 1_000 }],
    stale: [{ sku: "A-100", cents: 900 }],
  },
};

// ---------------------------------------------------------------------------------------------
// The service's own value formatting and parsing
// ---------------------------------------------------------------------------------------------

const two = (n: number) => (n < 10 ? `0${n}` : String(n));

/** `$1,234.56` from cents, the format of the 2014 money serializer. */
const formatMoney = (cents: number): string => {
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const units = String(Math.trunc(absolute / 100));
  const groups: Array<string> = [];
  for (let end = units.length; end > 0; end -= 3)
    groups.unshift(units.slice(Math.max(0, end - 3), end));
  return `${negative ? "-" : ""}$${groups.join(",")}.${two(absolute % 100)}`;
};

const moneyPattern = /^(-?)\$((?:[1-9]\d{0,2}(?:,\d{3})*)|0)\.(\d\d)$/;

const parseMoney = (text: unknown): number | undefined => {
  if (typeof text !== "string") return undefined;
  const match = moneyPattern.exec(text);
  if (match === null) return undefined;
  const cents = Number(match[2]!.split(",").join("")) * 100 + Number(match[3]);
  if (match[1] === "-" && cents === 0) return undefined;
  return match[1] === "-" ? -cents : cents;
};

const formatDotNet = (date: DotNetDate): string => {
  if (date.offsetMinutes === null) return `/Date(${date.epochMillis})/`;
  const sign = date.offsetMinutes < 0 ? "-" : "+";
  const minutes = Math.abs(date.offsetMinutes);
  return `/Date(${date.epochMillis}${sign}${two(Math.floor(minutes / 60))}${two(minutes % 60)})/`;
};

const dotNetPattern = /^\/Date\((-?(?:0|[1-9]\d*))(?:([+-])(\d\d)(\d\d))?\)\/$/;

const parseDotNet = (text: unknown): DotNetDate | undefined => {
  if (typeof text !== "string") return undefined;
  const match = dotNetPattern.exec(text);
  if (match === null) return undefined;
  const epochMillis = Number(match[1]);
  if (!Number.isSafeInteger(epochMillis)) return undefined;
  if (match[2] === undefined) return { epochMillis, offsetMinutes: null };
  const hours = Number(match[3]);
  const minutes = Number(match[4]);
  if (minutes > 59 || hours * 60 + minutes > 840) return undefined;
  return {
    epochMillis,
    offsetMinutes: (match[2] === "-" ? -1 : 1) * (hours * 60 + minutes),
  };
};

/** .NET's en-US general format, `M/d/yyyy h:mm:ss tt`. */
const formatWallClock = (clock: WallClock): string => {
  const twelve = clock.hour % 12 === 0 ? 12 : clock.hour % 12;
  return (
    `${clock.month}/${clock.day}/${String(clock.year).padStart(4, "0")} ` +
    `${twelve}:${two(clock.minute)}:${two(clock.second)} ${clock.hour >= 12 ? "PM" : "AM"}`
  );
};

const wallClockPattern =
  /^([1-9]|1[0-2])\/([1-9]|[12]\d|3[01])\/(\d{4}) ([1-9]|1[0-2]):([0-5]\d):([0-5]\d) ([AP]M)$/;

const parseWallClock = (text: unknown): WallClock | undefined => {
  if (typeof text !== "string") return undefined;
  const match = wallClockPattern.exec(text);
  if (match === null) return undefined;
  const year = Number(match[3]);
  const month = Number(match[1]);
  const day = Number(match[2]);
  // Day 0 of the next month is the last day of this one.
  const last = new Date(Date.UTC(2000, month, 0)).getUTCDate();
  const leapAware =
    month === 2
      ? (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
        ? 29
        : 28
      : last;
  if (year === 0 || day > leapAware) return undefined;
  const twelve = Number(match[4]) % 12;
  return {
    year,
    month,
    day,
    hour: match[7] === "PM" ? twelve + 12 : twelve,
    minute: Number(match[5]),
    second: Number(match[6]),
  };
};

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const monthNames = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** What `HttpServletResponse.setDateHeader` writes: an IMF-fixdate with whole seconds. */
const servletDate = (millis: number): string => {
  const date = new Date(millis);
  return (
    `${dayNames[date.getUTCDay()]}, ${two(date.getUTCDate())} ${monthNames[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:` +
    `${two(date.getUTCSeconds())} GMT`
  );
};

const flag = (value: boolean): "Y" | "N" => (value ? "Y" : "N");

const parseFlag = (value: unknown): boolean | undefined =>
  value === "Y" ? true : value === "N" ? false : undefined;

const parseWords = (value: unknown): ReadonlyArray<string> | undefined =>
  typeof value === "string" && /^(?:\S+(?: \S+)*)?$/.test(value)
    ? value === ""
      ? []
      : value.split(" ")
    : undefined;

// ---------------------------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------------------------

type Handle = Route["handle"];

const error = (
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  lines: Lines = [],
): Reply => json(status, { error: code, ...extra }, lines);

/** JSON as the 2014 serializer wrote it, with ASP.NET dates behind escaped slashes. */
const dotNetJson = (
  status: number,
  value: unknown,
  lines: Lines = [],
): Reply => ({
  status,
  lines: [["Content-Type", "application/json; charset=utf-8"], ...lines],
  body: JSON.stringify(value).replace(
    /"\/Date\((-?\d+(?:[+-]\d{4})?)\)\/"/g,
    String.raw`"\/Date($1)\/"`,
  ),
});

type FieldError = { readonly field: string; readonly message: string };

const invalid = (errors: ReadonlyArray<FieldError>): Reply =>
  json(422, { errors });

type BodyResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly reply: Reply };

const readObject = (request: Received): BodyResult => {
  const type = header(request.lines, "content-type") ?? "";
  if (!/^application\/json\s*(?:;|$)/i.test(type))
    return {
      ok: false,
      reply: error(415, "unsupported_media_type", {
        error_description: "send application/json",
      }),
    };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(request.body));
  } catch {
    return { ok: false, reply: error(400, "malformed_json") };
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ok: true, value: value as Record<string, unknown> }
    : { ok: false, reply: invalid([{ field: "", message: "an object" }]) };
};

/** The value of a query parameter: the last of repeated names. */
const lastQueryValue = (request: Received, name: string): string | undefined =>
  new URL(request.target, "http://service.invalid").searchParams
    .getAll(name)
    .at(-1);

/** Wait `ms`, ending early if the client goes away. Resolves `true` when the wait completed. */
const hold = (ms: number, signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const abort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });

/**
 * A whole-second instant at least `lead` milliseconds ahead. HTTP-dates have one-second
 * resolution, so the wait a client derives from one lies between `lead` and `lead + 1000`.
 */
const nextWholeSecond = (lead: number): number =>
  Math.ceil((Date.now() + lead) / 1000) * 1000;

/** Timer slack: a retry arriving this close before the advertised instant is still on time. */
const slack = 50;

const assigneePattern = /^[A-Za-z0-9._:@-]{1,64}$/;

/** Validate task fields. `partial` skips missing fields, as PATCH does. */
const validateTask = (
  body: Record<string, unknown>,
  partial: boolean,
): ReadonlyArray<FieldError> => {
  const errors: Array<FieldError> = [];
  const present = (field: string) => !partial || field in body;
  if (present("title")) {
    const title = body["title"];
    if (typeof title !== "string" || title.trim() === "")
      errors.push({ field: "title", message: "required" });
    else if (title.length > 200)
      errors.push({ field: "title", message: "at most 200 characters" });
  }
  if (present("assigneeId")) {
    const id = body["assigneeId"];
    if (typeof id !== "string" || !assigneePattern.test(id))
      errors.push({ field: "assigneeId", message: "invalid assignee id" });
  }
  if (present("priority")) {
    const priority = body["priority"];
    if (typeof priority !== "number" || ![1, 2, 3, 4].includes(priority))
      errors.push({ field: "priority", message: "an integer from 1 to 4" });
  }
  if (
    "due" in body &&
    body["due"] !== null &&
    parseDotNet(body["due"]) === undefined
  )
    errors.push({ field: "due", message: "null or /Date(ms)/" });
  if ("notes" in body) {
    const notes = body["notes"];
    if (notes !== null && (typeof notes !== "string" || notes.length > 2000))
      errors.push({
        field: "notes",
        message: "null or at most 2000 characters",
      });
  }
  if ("done" in body && parseFlag(body["done"]) === undefined)
    errors.push({ field: "done", message: "Y or N" });
  return errors;
};

const notFound = (id: string) => error(404, "task_not_found", { id });

/** The path of one item of a resource, with its id as a named group. */
const item = (resource: string) => new RegExp(`^/v2/${resource}/(?<id>[^/]+)$`);

const priceJson = (version: number, prices: ReadonlyArray<PriceSeed>) => ({
  version,
  prices: prices.map((price) => ({
    sku: price.sku,
    price: formatMoney(price.cents),
  })),
});

/** Mark a reply as coming through the edge. */
const viaEdgeLines = (reply: Reply, lines: Lines): Reply => ({
  ...reply,
  lines: [...(reply.lines ?? []), ...lines, ["Via", "1.1 edge"]],
});

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

interface Task {
  readonly id: string;
  title: string;
  assigneeId: string;
  priority: number;
  due: DotNetDate | null;
  notes: string | null;
  done: boolean;
  readonly created: number;
}

interface HistoryEvent {
  readonly task: string;
  readonly action: "created" | "updated" | "deleted";
  readonly at: number;
}

/** Routes of this part of the business API, with fresh state per call. */
export const routes = (given?: Options): ReadonlyArray<Route> => {
  const options: Required<Options> = { ...defaults, ...given };
  const stamp = () => options.clock ?? Date.now();

  // --- Abandoned held requests -----------------------------------------------------------------
  const abandoned: Array<{
    readonly route: "search" | "events";
    readonly target: string;
  }> = [];
  const abandonWaiters = new Set<() => void>();
  const abandon = (route: "search" | "events", request: Received) => {
    abandoned.push({ route, target: request.target });
    for (const wake of Array.from(abandonWaiters)) wake();
  };
  const opsAbandoned: Handle = async (request, context) => {
    const atLeast = Number(lastQueryValue(request, "atLeast") ?? 0);
    if (abandoned.length < atLeast)
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          abandonWaiters.delete(check);
          context.signal.removeEventListener("abort", done);
          resolve();
        };
        const check = () => {
          if (abandoned.length >= atLeast) done();
        };
        const timer = setTimeout(done, 2_000);
        abandonWaiters.add(check);
        context.signal.addEventListener("abort", done, { once: true });
      });
    return json(200, { abandoned });
  };

  // --- Authentication --------------------------------------------------------------------------
  const authorize = (request: Received): Reply | undefined => {
    const values = headerValues(request.lines, "authorization");
    if (values.length > 1) return error(400, "invalid_request");
    const match = /^bearer (\S+)$/i.exec(values[0] ?? "");
    if (match === null)
      return error(
        401,
        "invalid_request",
        { error_description: "a bearer token is required" },
        [["WWW-Authenticate", 'Bearer realm="business-v2"']],
      );
    if (match[1] !== options.token)
      return error(
        401,
        "invalid_token",
        { error_description: "the token is not valid" },
        [
          [
            "WWW-Authenticate",
            'Bearer realm="business-v2", error="invalid_token"',
          ],
        ],
      );
    return undefined;
  };

  const withAuth =
    (handle: Handle): Handle =>
    (request, context) =>
      authorize(request) ?? handle(request, context);

  // --- Tasks -----------------------------------------------------------------------------------
  const tasks = new Map<string, Task>();
  const history: Array<HistoryEvent> = [];
  let nextTask = 1001;
  for (const seed of options.tasks) {
    const id = `T-${nextTask++}`;
    tasks.set(id, { id, ...seed });
    history.push({ task: id, action: "created", at: seed.created });
  }

  const taskJson = (task: Task) => ({
    id: task.id,
    title: task.title,
    assigneeId: task.assigneeId,
    priority: task.priority,
    due: task.due === null ? null : formatDotNet(task.due),
    notes: task.notes,
    done: flag(task.done),
    created: task.created,
  });

  const listTasks: Handle = (request) => {
    const assignee = lastQueryValue(request, "assignee");
    const status = lastQueryValue(request, "status");
    if (status !== undefined && status !== "open" && status !== "done")
      return error(400, "invalid_filter", { field: "status" });
    const items = Array.from(tasks.values()).filter(
      (task) =>
        (assignee === undefined || task.assigneeId === assignee) &&
        (status === undefined || task.done === (status === "done")),
    );
    return dotNetJson(200, {
      applied: { assignee: assignee ?? null, status: status ?? null },
      items: items.map(taskJson),
      count: items.length,
    });
  };

  const createTask: Handle = (request) => {
    const body = readObject(request);
    if (!body.ok) return body.reply;
    const fields = body.value;
    const errors = validateTask(fields, false);
    if (errors.length > 0) return invalid(errors);
    const id = `T-${nextTask++}`;
    const task: Task = {
      id,
      title: fields["title"] as string,
      assigneeId: fields["assigneeId"] as string,
      priority: fields["priority"] as number,
      due: parseDotNet(fields["due"]) ?? null,
      notes: (fields["notes"] as string | null | undefined) ?? null,
      done: false,
      created: stamp(),
    };
    tasks.set(id, task);
    history.push({ task: id, action: "created", at: task.created });
    return dotNetJson(201, taskJson(task), [["Location", `/v2/tasks/${id}`]]);
  };

  const readTask: Handle = (_, { params }) => {
    const task = tasks.get(params["id"]!);
    return task === undefined
      ? notFound(params["id"]!)
      : dotNetJson(200, taskJson(task));
  };

  const writeTask =
    (method: "PUT" | "PATCH"): Handle =>
    (request, { params }) => {
      const task = tasks.get(params["id"]!);
      if (task === undefined) return notFound(params["id"]!);
      const body = readObject(request);
      if (!body.ok) return body.reply;
      const fields = body.value;
      const errors = validateTask(fields, method === "PATCH");
      if (errors.length > 0) return invalid(errors);
      const replace = method === "PUT";
      if ("title" in fields) task.title = fields["title"] as string;
      if ("assigneeId" in fields)
        task.assigneeId = fields["assigneeId"] as string;
      if ("priority" in fields) task.priority = fields["priority"] as number;
      if ("due" in fields) task.due = parseDotNet(fields["due"]) ?? null;
      else if (replace) task.due = null;
      if ("notes" in fields) task.notes = fields["notes"] as string | null;
      else if (replace) task.notes = null;
      if ("done" in fields) task.done = parseFlag(fields["done"])!;
      else if (replace) task.done = false;
      history.push({ task: task.id, action: "updated", at: stamp() });
      return dotNetJson(200, taskJson(task));
    };

  const deleteTask: Handle = (_, { params }) => {
    const id = params["id"]!;
    if (!tasks.delete(id)) return notFound(id);
    history.push({ task: id, action: "deleted", at: stamp() });
    return { status: 204 };
  };

  const taskHistory: Handle = (_, { params }) => {
    const id = params["id"]!;
    const events = history.filter((event) => event.task === id);
    return events.length === 0 ? notFound(id) : dotNetJson(200, { events });
  };

  const search: Handle = async (request, context) => {
    const q = lastQueryValue(request, "q");
    if (q === undefined || q.trim() === "") return error(400, "query_required");
    const completed = await hold(
      Math.max(0, options.searchLatency[q] ?? 0),
      context.signal,
    );
    if (!completed) {
      abandon("search", request);
      return { status: 499 };
    }
    const needle = q.toLowerCase();
    const hits = Array.from(tasks.values()).filter(
      (task) =>
        task.title.toLowerCase().includes(needle) ||
        (task.notes ?? "").toLowerCase().includes(needle),
    );
    return dotNetJson(200, { query: q, hits: hits.map(taskJson) });
  };

  // --- STAT-8: the 420 limiter -----------------------------------------------------------------
  const calm = new Map<
    string,
    { readonly stage: "calm" | "feed" | "ready"; readonly until: number }
  >();
  const rates: Handle = (_, { params }) => {
    const pair = params["pair"]!;
    const state = calm.get(pair);
    const now = Date.now();
    if (
      state === undefined ||
      (state.stage === "calm" && now < state.until - slack)
    ) {
      const until = state?.until ?? now + 1000;
      calm.set(pair, { stage: "calm", until });
      return {
        status: 420,
        statusText: "Enhance Your Calm",
        lines: [
          ["Content-Type", "application/json"],
          ["Retry-After", String(Math.max(1, Math.ceil((until - now) / 1000)))],
        ],
        body: JSON.stringify({ error: "enhance_your_calm" }),
      };
    }
    if (state.stage === "calm") {
      calm.set(pair, { stage: "feed", until: now });
      return error(503, "quote_feed_reconnecting");
    }
    calm.set(pair, { stage: "ready", until: now });
    return json(200, { pair, rate: "1.0842", asOf: stamp() });
  };

  // --- STAT-9: Retry-After in seconds and as HTTP-dates ----------------------------------------
  const reportState = new Map<
    string,
    {
      readonly stage: "limited" | "maintenance" | "ready";
      readonly until: number;
    }
  >();
  const reports: Handle = (_, { params }) => {
    const name = params["name"]!;
    const state = reportState.get(name);
    const now = Date.now();
    if (state === undefined) {
      reportState.set(name, { stage: "limited", until: now + 1000 });
      return error(429, "rate_limited", {}, [["Retry-After", "1"]]);
    }
    if (state.stage !== "ready" && now < state.until - slack) {
      if (state.stage === "limited")
        return error(429, "rate_limited", {}, [
          [
            "Retry-After",
            String(Math.max(1, Math.ceil((state.until - now) / 1000))),
          ],
        ]);
      return error(503, "maintenance", {}, [
        ["Retry-After", servletDate(state.until)],
      ]);
    }
    if (state.stage === "limited") {
      const until = nextWholeSecond(500);
      reportState.set(name, { stage: "maintenance", until });
      return error(503, "maintenance", {}, [
        ["Retry-After", servletDate(until)],
      ]);
    }
    reportState.set(name, { stage: "ready", until: 0 });
    return json(200, {
      report: name,
      rows: [["2023-11", formatMoney(123_456)]],
    });
  };

  const exportState = new Map<string, number>();
  const exportsRoute: Handle = (_, { params }) => {
    const name = params["name"]!;
    const until = exportState.get(name);
    const now = Date.now();
    if (until === undefined || now < until - slack) {
      const next = until ?? nextWholeSecond(500);
      exportState.set(name, next);
      return error(429, "rate_limited", {}, [
        ["Retry-After", servletDate(next)],
      ]);
    }
    return json(200, { export: name, status: "ready" });
  };

  // --- HDR-8: the edge cache -------------------------------------------------------------------
  const catalogPath = "/v2/catalog/prices";
  const origin = {
    prices: options.catalog.prices.map((price) => ({ ...price })),
    version: 2,
  };
  const cacheable: Lines = [["Cache-Control", "public, max-age=86400"]];
  const edge = new Map<
    string,
    { readonly reply: Reply; readonly stored: number }
  >();
  // Warm at start with the stale list, stored an hour ago.
  edge.set(catalogPath, {
    reply: json(200, priceJson(1, options.catalog.stale), cacheable),
    stored: Date.now() - 3_600_000,
  });

  /** The edge in front of the catalogue, keyed on the path plus the `v` parameter only. */
  const viaEdge = (request: Received, forward: () => Reply): Reply => {
    if (request.method === "PURGE") {
      let purged = 0;
      for (const key of Array.from(edge.keys()))
        if (key === catalogPath || key.startsWith(`${catalogPath}?`)) {
          edge.delete(key);
          purged++;
        }
      return viaEdgeLines(json(200, { status: "ok", purged }), []);
    }
    if (request.method !== "GET") return forward();
    const version = lastQueryValue(request, "v");
    const key =
      version === undefined ? catalogPath : `${catalogPath}?v=${version}`;
    const hit = edge.get(key);
    if (hit !== undefined)
      return viaEdgeLines(hit.reply, [
        ["X-Cache", "HIT"],
        ["Age", String(Math.floor((Date.now() - hit.stored) / 1000))],
      ]);
    const reply = forward();
    if (reply.status === 200) edge.set(key, { reply, stored: Date.now() });
    return viaEdgeLines(reply, [
      ["X-Cache", "MISS"],
      ["Age", "0"],
    ]);
  };

  const catalog: Handle = (request) =>
    viaEdge(request, () => {
      if (request.method === "GET")
        return json(200, priceJson(origin.version, origin.prices), cacheable);
      if (request.method !== "POST")
        return error(405, "method_not_allowed", {}, [
          ["Allow", "GET, POST, PURGE"],
        ]);
      const body = readObject(request);
      if (!body.ok) return body.reply;
      const cents = parseMoney(body.value["price"]);
      const entry = origin.prices.find(
        (price) => price.sku === body.value["sku"],
      );
      if (cents === undefined)
        return invalid([
          { field: "price", message: "a formatted dollar amount" },
        ]);
      if (entry === undefined) return error(404, "sku_not_found");
      entry.cents = cents;
      origin.version++;
      return json(200, priceJson(origin.version, origin.prices));
    });

  // --- VAL-1b to VAL-5b: invoices --------------------------------------------------------------
  const customers = new Map(
    options.customers.map((customer) => [customer.id, customer]),
  );
  const invoices = new Map(
    options.invoices.map((invoice) => [invoice.id, invoice]),
  );
  let lastModified = options.invoicesModified;

  /** Invoice rows, expanding each customer at its first appearance in the response only. */
  const invoiceJson = (rows: ReadonlyArray<InvoiceSeed>) => {
    const seen = new Set<number>();
    return rows.map((row) => {
      const customer = customers.get(row.customerId);
      const expanded = customer !== undefined && !seen.has(customer.id);
      seen.add(row.customerId);
      return {
        id: row.id,
        customer: expanded ? { ...customer } : row.customerId,
        amount: formatMoney(row.amountCents),
        paid: flag(row.paid),
        issued: row.issued,
        due: formatDotNet(row.due),
        printed: formatWallClock(row.printed),
        tags: row.tags.join(" "),
        ...(row.poNumber === undefined ? {} : { poNumber: row.poNumber }),
        seatLimit: row.seatLimit === "unlimited" ? -1 : row.seatLimit,
      };
    });
  };

  const invoiceLines = (): Lines => [
    ["Last-Modified", servletDate(lastModified)],
  ];

  const replaceInvoice: Handle = (request, { params }) => {
    const id = Number(params["id"]);
    if (!invoices.has(id)) return error(404, "invoice_not_found", { id });
    const body = readObject(request);
    if (!body.ok) return body.reply;
    const fields = body.value;
    const errors: Array<FieldError> = [];
    const customerField = fields["customer"];
    const customerId =
      typeof customerField === "object" && customerField !== null
        ? (customerField as Record<string, unknown>)["id"]
        : customerField;
    if (typeof customerId !== "number" || !customers.has(customerId))
      errors.push({
        field: "customer",
        message: "an existing customer id or object",
      });
    const amountCents = parseMoney(fields["amount"]);
    if (amountCents === undefined)
      errors.push({
        field: "amount",
        message: "a formatted dollar amount such as $1,234.56",
      });
    const paid = parseFlag(fields["paid"]);
    if (paid === undefined) errors.push({ field: "paid", message: "Y or N" });
    const issued = fields["issued"];
    if (typeof issued !== "number" || !Number.isSafeInteger(issued))
      errors.push({ field: "issued", message: "epoch milliseconds" });
    const due = parseDotNet(fields["due"]);
    if (due === undefined)
      errors.push({ field: "due", message: "/Date(ms)/ or /Date(ms±hhmm)/" });
    const printed = parseWallClock(fields["printed"]);
    if (printed === undefined)
      errors.push({ field: "printed", message: "M/d/yyyy h:mm:ss AM or PM" });
    const tags = parseWords(fields["tags"]);
    if (tags === undefined)
      errors.push({ field: "tags", message: "space-delimited words" });
    const poNumber = fields["poNumber"];
    if (
      poNumber !== undefined &&
      poNumber !== null &&
      typeof poNumber !== "string"
    )
      errors.push({ field: "poNumber", message: "text or null" });
    const seats = fields["seatLimit"];
    if (typeof seats !== "number" || !Number.isInteger(seats) || seats < -1)
      errors.push({
        field: "seatLimit",
        message: "-1 for unlimited or a count",
      });
    if (errors.length > 0) return invalid(errors);
    const stored: InvoiceSeed = {
      id,
      customerId: customerId as number,
      amountCents: amountCents!,
      paid: paid!,
      issued: issued as number,
      due: due!,
      printed: printed!,
      tags: tags!,
      ...(poNumber === undefined
        ? {}
        : { poNumber: poNumber as string | null }),
      seatLimit: seats === -1 ? "unlimited" : (seats as number),
    };
    invoices.set(id, stored);
    lastModified = Math.floor(Date.now() / 1000) * 1000;
    return dotNetJson(200, invoiceJson([stored])[0], invoiceLines());
  };

  // --- RET-1: payouts behind a nonce and a warm-up ---------------------------------------------
  let lastNonce = 0n;
  let warmup: { readonly stage: 0 | 1 | 2; readonly until: number } = {
    stage: 0,
    until: 0,
  };
  let payoutCount = 0;

  const payouts: Handle = (request) => {
    const nonceText = header(request.lines, "x-nonce");
    if (nonceText === undefined || !/^(?:0|[1-9]\d{0,30})$/.test(nonceText))
      return error(400, "nonce_required");
    const expected = createHmac("sha256", options.token)
      .update(`${nonceText}.`)
      .update(request.body)
      .digest();
    const presented = Buffer.from(
      header(request.lines, "x-signature") ?? "",
      "hex",
    );
    if (
      presented.length !== expected.length ||
      !timingSafeEqual(presented, expected)
    )
      return error(401, "bad_signature");
    // The replay check runs before the warm-up check, so a nonce is spent even when the service
    // then refuses to work.
    const nonce = BigInt(nonceText);
    if (nonce <= lastNonce)
      return error(409, "nonce_replayed", { last: lastNonce.toString() });
    lastNonce = nonce;
    const now = Date.now();
    // Two warm-up stages, each entered by the first request after the previous one ended.
    if (now >= warmup.until - slack && warmup.stage < 2)
      warmup = {
        stage: (warmup.stage + 1) as 1 | 2,
        until: nextWholeSecond(250),
      };
    if (now < warmup.until - slack)
      return error(503, "warming_up", { stage: warmup.stage }, [
        ["Retry-After", servletDate(warmup.until)],
      ]);
    const body = readObject(request);
    if (!body.ok) return body.reply;
    if (
      parseMoney(body.value["amount"]) === undefined ||
      typeof body.value["to"] !== "string"
    )
      return invalid([
        { field: "amount", message: "a formatted dollar amount and a payee" },
      ]);
    payoutCount++;
    return json(
      201,
      {
        payout: `P-${payoutCount}`,
        amount: body.value["amount"],
        to: body.value["to"],
        nonce: nonceText,
      },
      [["Location", `/v2/payouts/P-${payoutCount}`]],
    );
  };

  // --- RET-2: the long poll --------------------------------------------------------------------
  type Published = { readonly id: number; readonly type: string };
  let cursor = 0;
  const waiting = new Set<(event: Published) => void>();

  const events: Handle = async (request, context) => {
    const outcome = await new Promise<Published | "timeout" | "aborted">(
      (resolve) => {
        const abort = () => {
          clearTimeout(timer);
          waiting.delete(deliver);
          resolve("aborted");
        };
        const deliver = (published: Published) => {
          clearTimeout(timer);
          context.signal.removeEventListener("abort", abort);
          resolve(published);
        };
        const timer = setTimeout(() => {
          waiting.delete(deliver);
          context.signal.removeEventListener("abort", abort);
          resolve("timeout");
        }, options.longPollHold);
        waiting.add(deliver);
        if (context.signal.aborted) abort();
        else context.signal.addEventListener("abort", abort, { once: true });
      },
    );
    if (outcome === "aborted") {
      abandon("events", request);
      return { status: 499 };
    }
    if (outcome === "timeout") return json(200, { events: [], next: cursor });
    return json(200, { events: [outcome], next: outcome.id });
  };

  const publish: Handle = (request) => {
    const body = readObject(request);
    if (!body.ok) return body.reply;
    if (typeof body.value["type"] !== "string")
      return invalid([{ field: "type", message: "required" }]);
    const event = { id: ++cursor, type: body.value["type"] };
    for (const deliver of Array.from(waiting)) {
      waiting.delete(deliver);
      deliver(event);
    }
    return json(202, { accepted: event.id });
  };

  // --- Routing ---------------------------------------------------------------------------------
  const service = router(
    [
      { method: "GET", path: "/v2/tasks", handle: withAuth(listTasks) },
      { method: "POST", path: "/v2/tasks", handle: withAuth(createTask) },
      {
        method: "GET",
        path: "/v2/tasks/history",
        handle: withAuth(() => dotNetJson(200, { events: history })),
      },
      {
        method: "GET",
        path: /^\/v2\/tasks\/(?<id>[^/]+)\/history$/,
        handle: withAuth(taskHistory),
      },
      { method: "GET", path: item("tasks"), handle: withAuth(readTask) },
      {
        method: "PUT",
        path: item("tasks"),
        handle: withAuth(writeTask("PUT")),
      },
      {
        method: "PATCH",
        path: item("tasks"),
        handle: withAuth(writeTask("PATCH")),
      },
      { method: "DELETE", path: item("tasks"), handle: withAuth(deleteTask) },
      {
        method: "POST",
        path: item("tasks"),
        handle: () =>
          error(400, "override_required", {
            error_description:
              "send X-HTTP-Method-Override: PUT, PATCH or DELETE",
          }),
      },
      { method: "GET", path: "/v2/search", handle: withAuth(search) },
      {
        method: "GET",
        path: /^\/v2\/rates\/(?<pair>[A-Z]{6})$/,
        handle: rates,
      },
      {
        method: "GET",
        path: /^\/v2\/reports\/(?<name>[^/]+)$/,
        handle: reports,
      },
      {
        method: "GET",
        path: /^\/v2\/exports\/(?<name>[^/]+)$/,
        handle: exportsRoute,
      },
      { method: "*", path: catalogPath, handle: catalog },
      {
        method: "GET",
        path: "/v2/invoices",
        handle: () =>
          dotNetJson(
            200,
            { invoices: invoiceJson(Array.from(invoices.values())) },
            invoiceLines(),
          ),
      },
      {
        method: "GET",
        path: item("invoices"),
        handle: (_, { params }) => {
          const invoice = invoices.get(Number(params["id"]));
          return invoice === undefined
            ? error(404, "invoice_not_found", { id: params["id"] })
            : dotNetJson(200, invoiceJson([invoice])[0], invoiceLines());
        },
      },
      { method: "PUT", path: item("invoices"), handle: replaceInvoice },
      { method: "POST", path: "/v2/payouts", handle: withAuth(payouts) },
      { method: "GET", path: "/v2/events", handle: events },
      { method: "POST", path: "/v2/events", handle: publish },
      { method: "GET", path: "/v2/ops/abandoned", handle: opsAbandoned },
    ],
    (request) =>
      error(404, "not_found", { path: request.target.split("?")[0] }),
  );

  const gatewayMethods = ["GET", "HEAD", "POST", "OPTIONS"];
  const overrides = ["PUT", "PATCH", "DELETE"];

  /**
   * The API gateway in front of the service, in the order the infrastructure applies it: merged
   * slashes, the method allowlist (with PURGE passed to the edge), and the tunnel.
   */
  const front = (
    request: Received,
    context: Context,
  ): Reply | Promise<Reply> => {
    const query = request.target.indexOf("?");
    const rawPath = query < 0 ? request.target : request.target.slice(0, query);
    // nginx `merge_slashes on`.
    const path = rawPath.replace(/\/{2,}/g, "/");
    const target = query < 0 ? path : `${path}${request.target.slice(query)}`;
    const toEdge = path === catalogPath && request.method === "PURGE";
    if (!gatewayMethods.includes(request.method) && !toEdge)
      return {
        status: 405,
        lines: [
          ["Content-Type", "application/json"],
          ["Allow", gatewayMethods.join(", ")],
          ["Via", "1.1 api-gateway"],
        ],
        body: JSON.stringify({ message: "Method Not Allowed" }),
      };
    const override = header(request.lines, "x-http-method-override");
    let method = request.method;
    if (override !== undefined && request.method === "POST") {
      if (!overrides.includes(override))
        return error(400, "unsupported_override", { allowed: overrides });
      method = override;
    }
    return service({ ...request, method, target }, context);
  };

  return [{ method: "*", path: /^\/v2(?:\/|$)/, handle: front }];
};
