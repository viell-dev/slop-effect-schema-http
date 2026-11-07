/**
 * Berth, the regional booking service: one region and the edge in front of it. The handler applies
 * the layers in the page's order: the CORS filter's preflight, the edge's pick of a fault, the
 * region, and then a fault with `phase: "after"` on the region's answer. Every call to
 * {@link handler} is a new region with no bookings.
 *
 * Service documentation: services/bookings.md
 */
import { request as linkRequest } from "node:http";
import { json, rawRouter, type Route, textReply } from "../../harness/route.js";
import {
  type Handler,
  header,
  type Lines,
  query,
  type RawHandler,
  type RawReply,
  type Received,
  type Reply,
} from "../../harness/server.js";
import {
  type Answer,
  answerOf,
  edge,
  type EdgeRule,
  head,
  type Readable,
} from "./edge.js";
import { exported } from "./exports.js";

/** The test options, documented under "Test options" in the service page. */
export interface Options {
  readonly region?: string;
  readonly edge?: ReadonlyArray<EdgeRule>;
  readonly peer?: string;
  readonly redirects?: Readonly<
    Record<string, { readonly status: number; readonly location: string }>
  >;
  readonly held?: ReadonlyArray<string>;
  readonly cors?: { readonly allowHeaders: ReadonlyArray<string> };
}

interface Booking {
  readonly id: string;
  readonly region: string;
  readonly vessel: string;
  readonly terminal: string;
  readonly slot: string;
  readonly key: string | null;
  readonly replayed: boolean;
}

/** How long the peer link waits for a whole answer. */
const LINK_TIMEOUT_MS = 1000;

const OPEN_SLOTS = ["06:00", "07:00", "08:00", "09:00"];

const manifest = Array.from(
  { length: 100 },
  (_, index) => `line ${String(index + 1).padStart(3, "0")}\n`,
).join("");

const notFound = () => textReply(404, "Not Found", "text/plain");

const readJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
};

const filled = (field: unknown): field is string =>
  typeof field === "string" && field !== "";

/** A booking's three fields, or undefined when `bytes` is not such an object. */
const draftOf = (bytes: Uint8Array) => {
  const value = readJson(bytes);
  if (typeof value !== "object" || value === null) return undefined;
  const { vessel, terminal, slot } = value as Readonly<Record<string, unknown>>;
  return filled(vessel) && filled(terminal) && filled(slot)
    ? { vessel, terminal, slot }
    : undefined;
};

/**
 * Ask the peer for `key`, over a connection of the link's own. Everything but a 200 that holds a
 * booking counts as the peer not knowing the key, so this never fails.
 */
const askPeer = (peer: URL, key: string): Promise<Booking | undefined> =>
  new Promise((resolve) => {
    const nothing = () => resolve(undefined);
    const link = linkRequest(
      new URL(`/v1/keys/${key}`, peer),
      { agent: false, signal: AbortSignal.timeout(LINK_TIMEOUT_MS) },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (data: Buffer) => chunks.push(data));
        response.on("error", nothing);
        response.on("end", () => {
          const value = readJson(Buffer.concat(chunks)) as
            Partial<Booking> | null | undefined;
          resolve(
            response.statusCode === 200 && typeof value?.id === "string"
              ? (value as Booking)
              : undefined,
          );
        });
      },
    );
    link.on("error", nothing);
    link.end();
  });

/** The terminal a request names, if it names one. */
const terminalOf = (request: Received) =>
  query(request).get("terminal") || undefined;

const preflight = (
  request: Received,
  allowHeaders: ReadonlyArray<string>,
): Reply => {
  const origin = header(request.lines, "origin");
  return {
    status: 204,
    lines: [
      ...(origin === undefined
        ? []
        : ([["Access-Control-Allow-Origin", origin]] as const)),
      ["Access-Control-Allow-Methods", "GET, POST"],
      ["Access-Control-Allow-Headers", allowHeaders.join(", ")],
      ["Vary", "Origin"],
    ],
  };
};

/** Fresh region state per call. */
export const handler = (given: Options = {}): RawHandler => {
  const region = given.region ?? "eu";
  const held = new Set(given.held);
  const peer = given.peer === undefined ? undefined : new URL(given.peer);
  const pick = edge(given.edge ?? []);
  const bookings: Array<Booking> = [];
  const keys = new Map<
    string,
    { readonly booking: Booking; readonly bytes: Uint8Array }
  >();
  const gates = new Map<string, PromiseWithResolvers<void>>();

  /** What the CORS filter adds to one of the region's answers. */
  const gained = (request: Received): Lines => {
    const origin = header(request.lines, "origin");
    return given.cors === undefined || origin === undefined
      ? []
      : [
          ["Access-Control-Allow-Origin", origin],
          ["Vary", "Origin"],
        ];
  };

  const read = (request: Received, reply: Reply): Answer =>
    answerOf({
      ...reply,
      lines: [...(reply.lines ?? []), ...gained(request)],
    });

  const replayed = (booking: Booking) =>
    json(200, { ...booking, replayed: true }, [["Idempotent-Replay", "true"]]);

  /** The answer to a key known here, or undefined for one that is not. */
  const repeat = (key: string, bytes: Uint8Array): Reply | undefined => {
    const known = keys.get(key);
    if (known === undefined) return undefined;
    return Buffer.compare(known.bytes, bytes) === 0
      ? replayed(known.booking)
      : json(409, { error: "key_reused" });
  };

  const commit = (
    draft: NonNullable<ReturnType<typeof draftOf>>,
    key: string | undefined,
    bytes: Uint8Array,
  ): Reply => {
    const count = String(bookings.length + 1).padStart(6, "0");
    const booking: Booking = {
      id: `${region}-${count}`,
      region,
      ...draft,
      key: key ?? null,
      replayed: false,
    };
    bookings.push(booking);
    if (key !== undefined) keys.set(key, { booking, bytes });
    return json(201, booking, [["Location", `/v1/bookings/${booking.id}`]]);
  };

  const book = async (request: Received): Promise<Reply> => {
    const bytes = request.body;
    const key = header(request.lines, "idempotency-key");
    if (key !== undefined && !/^[A-Za-z0-9-]{1,64}$/.test(key))
      return json(400, { error: "invalid_key" });
    const known = key === undefined ? undefined : repeat(key, bytes);
    if (known !== undefined) return known;
    const draft = draftOf(bytes);
    if (draft === undefined) return json(400, { error: "invalid_booking" });
    if (key !== undefined && peer !== undefined) {
      const theirs = await askPeer(peer, key);
      if (theirs !== undefined) return replayed(theirs);
      // Another request may have committed this key while the link was out.
      const meanwhile = repeat(key, bytes);
      if (meanwhile !== undefined) return meanwhile;
    }
    return commit(draft, key, bytes);
  };

  /** The answer for a held terminal: half its body, then the rest once the terminal is released. */
  const holding = (
    request: Received,
    reply: Reply,
    terminal: string,
  ): Readable => {
    const answer = read(request, reply);
    const gate = gates.get(terminal) ?? Promise.withResolvers<void>();
    gates.set(terminal, gate);
    const half = Math.floor(answer.body.length / 2);
    return {
      head: head(answer, [
        `Content-Length: ${answer.body.length}`,
        // A raw reply ends its connection, so a client must not plan to reuse it.
        "Connection: close",
      ]),
      body: [
        answer.body.subarray(0, half),
        { until: gate.promise },
        answer.body.subarray(half),
      ],
      answer,
    };
  };

  const moved = Object.entries(given.redirects ?? {}).map(
    ([from, { status, location }]): Route<Reply | RawReply> => ({
      method: "*",
      path: from,
      handle: () => ({ status, lines: [["Location", location]] }),
    }),
  );

  // Every raw reply of these routes is `Readable`, which the router's type cannot say.
  const app = rawRouter([
    ...moved,
    {
      method: "GET",
      path: "/v1/health",
      handle: () => json(200, { service: "berth", region, status: "ok" }),
    },
    { method: "POST", path: "/v1/bookings", handle: book },
    {
      method: "GET",
      path: "/v1/bookings",
      handle: () => json(200, { region, bookings }),
    },
    {
      method: "GET",
      path: /^\/v1\/bookings\/(?<id>[^/]+)$/,
      handle: (_, { params }) => {
        const booking = bookings.find(({ id }) => id === params["id"]);
        return booking === undefined
          ? json(404, { error: "not_found" })
          : json(200, booking);
      },
    },
    {
      method: "GET",
      path: /^\/v1\/keys\/(?<key>[^/]+)$/,
      handle: (_, { params }) => {
        const known = keys.get(params["key"]!);
        return known === undefined
          ? json(404, { error: "unknown_key" })
          : json(200, known.booking);
      },
    },
    {
      method: "GET",
      path: "/v1/manifest",
      handle: () => textReply(200, manifest, "text/plain; charset=utf-8"),
    },
    {
      method: "GET",
      path: "/v1/availability",
      handle: (request) => {
        const terminal = terminalOf(request);
        if (terminal === undefined) return notFound();
        const reply = json(200, { terminal, open: OPEN_SLOTS });
        return held.has(terminal) ? holding(request, reply, terminal) : reply;
      },
    },
    {
      method: "POST",
      path: "/v1/availability/release",
      handle: (request) => {
        const terminal = terminalOf(request);
        if (terminal === undefined) return notFound();
        gates.get(terminal)?.resolve();
        gates.delete(terminal);
        return { status: 204 };
      },
    },
    {
      method: "GET",
      path: /^\/v1\/export\/(?<name>[^/]+)$/,
      handle: (_, { params }) => exported(params["name"]!) ?? notFound(),
    },
  ]) as Handler<Reply | Readable>;

  return async (request, context) => {
    if (given.cors !== undefined && request.method === "OPTIONS")
      return preflight(request, given.cors.allowHeaders);
    const fault = pick(request);
    if (fault?.phase === "before") return fault.write();
    const said = await app(request, context);
    const answer = "head" in said ? said.answer : read(request, said);
    if (fault !== undefined) return fault.write(answer);
    if ("head" in said) return said;
    // Without a length of its own, `node:http` would frame this in chunks.
    return answer.whole(
      said.status === 204
        ? []
        : [["Content-Length", String(answer.body.length)]],
      answer.body,
    );
  };
};
