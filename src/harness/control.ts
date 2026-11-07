import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect, Exit, Scope } from "effect";
import type { Json, Recorded } from "./lane.js";
import { loadHandler } from "./registry.js";
import {
  type Bytes,
  type Lines,
  type Listener,
  type RawHandler,
  type Received,
  type Server,
  serve,
} from "./server.js";

/**
 * The Node-side control server of the browser lane. Browser tests cannot open sockets, so they ask
 * this server to start backends, read their ledgers, wait for arrivals and stop them. It runs only
 * during the browser project's global setup.
 */

const first = (lines: Received["lines"], name: string) =>
  lines.find(([key]) => key.toLowerCase() === name)?.[1];

/** A CORS preflight: OPTIONS with `Access-Control-Request-Method`. Known from the head alone. */
const isPreflight = (request: Received): boolean =>
  request.method === "OPTIONS" &&
  first(request.lines, "access-control-request-method") !== undefined;

/** What the harness adds to a reply for `origin`, exposing `names` to the page. */
const corsLines = (origin: string, names: ReadonlyArray<string>): Lines => [
  ["Access-Control-Allow-Origin", origin],
  ["Access-Control-Allow-Credentials", "true"],
  ...(names.length === 0
    ? []
    : [["Access-Control-Expose-Headers", names.join(", ")] as const]),
  ["Vary", "Origin"],
];

/**
 * The head of a raw reply with the harness's CORS lines straight after its status line, so that a
 * page reads the failure the reply is about rather than a CORS refusal. The names it exposes are
 * read up to the first blank line, leaving out anything that could not be a header name. A head with
 * no line end, such as the empty head of a reply that writes nothing, has no place for them.
 */
const corsHead = (head: Bytes, origin: string): Bytes => {
  const text =
    typeof head === "string" ? head : Buffer.from(head).toString("latin1");
  const statusLineEnd = text.indexOf("\n") + 1;
  if (statusLineEnd === 0) return head;
  const names = text
    .slice(statusLineEnd)
    .split(/\r?\n\r?\n/, 1)[0]!
    .split(/\r?\n/)
    .map((line) => line.split(":", 1)[0]!)
    .filter((name) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name));
  const added = corsLines(origin, [...new Set(names)])
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  return `${text.slice(0, statusLineEnd)}${added}${text.slice(statusLineEnd)}`;
};

/**
 * Answer CORS preflights and expose every response header to the test page, so the page sees the
 * backend's own conventions. The ledger leaves the preflights this answers out.
 */
const withHarnessCors =
  (handler: RawHandler): RawHandler =>
  async (request, context) => {
    const origin = first(request.lines, "origin");
    const preflightMethod = first(
      request.lines,
      "access-control-request-method",
    );
    // The same test as `isPreflight`, written out so the method narrows to a string.
    if (request.method === "OPTIONS" && preflightMethod !== undefined) {
      return {
        status: 204,
        lines: [
          ["Access-Control-Allow-Origin", origin ?? "*"],
          ["Access-Control-Allow-Credentials", "true"],
          ["Access-Control-Allow-Methods", preflightMethod],
          [
            "Access-Control-Allow-Headers",
            first(request.lines, "access-control-request-headers") ?? "",
          ],
          // Each backend has an address of its own, so a cached preflight cannot reach another test,
          // and the ledger leaves these out, so a test cannot tell. The cache matters: a preflight
          // costs a browser more than the request it allows, and the lane's backends all share one
          // event loop with Vite and the reporter (#124).
          ["Access-Control-Max-Age", "600"],
          ["Vary", "Origin"],
        ],
      };
    }
    const reply = await handler(request, context);
    if (origin === undefined) return reply;
    if ("head" in reply)
      return { ...reply, head: corsHead(reply.head, origin) };
    const lines = (reply.lines ?? []).filter(
      ([name]) => !name.toLowerCase().startsWith("access-control-"),
    );
    return {
      ...reply,
      lines: [
        ...lines,
        ...corsLines(origin, [...new Set(lines.map(([name]) => name))]),
      ],
    };
  };

/**
 * Browsers scope cookies by host, not port, and keep them for the whole browser session, so
 * backends sharing an address would share one cookie jar across tests and areas. Each backend
 * started for the browser lane gets an address of its own from `127.0.1.2` onwards. That gives
 * 63,750 addresses before any repeats, far more than one run starts.
 */
const hostFor = (sequence: number): string =>
  `127.0.${1 + Math.floor((sequence - 1) / 250)}.${2 + ((sequence - 1) % 250)}`;

interface Running {
  readonly server: Server;
  readonly scope: Scope.Closeable;
  /** Which requests the ledger reports: all of them, or all but the harness's own preflights. */
  readonly include: (received: Received) => boolean;
}

/**
 * The ledger as the page sees it, read when asked: requests are recorded as their heads arrive, so
 * a body still arriving, or cut off by a disconnect, is reported as the bytes received so far.
 */
const recorded = (running: Running): ReadonlyArray<Recorded> =>
  running.server.ledger
    .filter((received) => running.include(received))
    .map((received) => ({
      method: received.method,
      target: received.target,
      lines: received.lines,
      head: received.head,
      body: received.body,
      aborted: received.aborted(),
      connection: received.connection,
      connectionOpen: received.connectionOpen(),
    }));

const readJson = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : JSON.parse(text);
};

export interface Control {
  readonly url: string;
  readonly close: () => Promise<void>;
}

export const startControl = (): Promise<Control> => {
  const running = new Map<string, Running>();
  let next = 0;

  const start = async (
    name: string,
    options: Json | undefined,
    cors: "harness" | "backend",
    listener: Listener,
  ) => {
    const id = String(++next);
    const scope = await Effect.runPromise(Scope.make());
    const inner = await loadHandler(name, options);
    const handler = cors === "harness" ? withHarnessCors(inner) : inner;
    const server = await Effect.runPromise(
      serve(handler, hostFor(Number(id)), listener).pipe(Scope.provide(scope)),
    );
    const include =
      cors === "harness"
        ? (received: Received) => !isPreflight(received)
        : () => true;
    running.set(id, { server, scope, include });
    return { id, origin: server.origin };
  };

  const stop = async (id: string) => {
    const entry = running.get(id);
    if (entry === undefined) return;
    running.delete(id);
    await Effect.runPromise(Scope.close(entry.scope, Exit.void));
  };

  const control = createServer((request, response) => {
    void (async () => {
      const cors = [
        ["Access-Control-Allow-Origin", request.headers.origin ?? "*"],
        ["Access-Control-Allow-Methods", "GET, POST, DELETE"],
        ["Access-Control-Allow-Headers", "content-type"],
      ] as const;
      const reply = (status: number, body?: unknown) => {
        response.writeHead(status, [
          ...cors.flat(),
          ...(body === undefined ? [] : ["Content-Type", "application/json"]),
        ]);
        response.end(body === undefined ? undefined : JSON.stringify(body));
      };
      try {
        const url = new URL(request.url ?? "/", "http://control");
        const match = /^\/backends\/(\d+)(\/ledger|\/arrived)?$/.exec(
          url.pathname,
        );
        if (request.method === "OPTIONS") return reply(204);
        if (request.method === "POST" && url.pathname === "/backends") {
          const body = (await readJson(request)) as {
            readonly name: string;
            readonly options?: Json;
            readonly cors?: "harness" | "backend";
            readonly listener?: Listener;
          };
          return reply(
            200,
            await start(
              body.name,
              body.options,
              body.cors ?? "harness",
              body.listener ?? "http",
            ),
          );
        }
        const entry = match === null ? undefined : running.get(match[1]!);
        if (match === null || entry === undefined) return reply(404);
        if (request.method === "GET" && match[2] === "/ledger")
          return reply(
            200,
            recorded(entry).map((item) => ({
              ...item,
              body: Buffer.from(item.body).toString("base64"),
            })),
          );
        if (request.method === "GET" && match[2] === "/arrived") {
          const count = Number(url.searchParams.get("count") ?? "1");
          await entry.server.arrived(count, entry.include);
          return reply(204);
        }
        if (request.method === "DELETE" && match[2] === undefined) {
          await stop(match[1]!);
          return reply(204);
        }
        return reply(405);
      } catch (cause) {
        reply(500, { error: String(cause) });
      }
    })();
  });

  return new Promise((resolve) =>
    control.listen(0, "127.0.0.1", () => {
      const { port } = control.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: async () => {
          await Promise.all([...running.keys()].map(stop));
          control.closeAllConnections();
          await new Promise<void>((done) => control.close(() => done()));
        },
      });
    }),
  );
};
