import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect, Exit, Scope } from "effect";
import type { Json, Recorded } from "./lane.js";
import { loadHandler } from "./registry.js";
import { type Handler, type Received, type Server, serve } from "./server.js";

/**
 * The Node-side control server of the browser lane. Browser tests cannot open sockets, so they ask
 * this server to start backends, read their ledgers, wait for arrivals and stop them. It runs only
 * during the browser project's global setup.
 */

const first = (lines: Received["lines"], name: string) =>
  lines.find(([key]) => key.toLowerCase() === name)?.[1];

/**
 * Answer CORS preflights and expose every response header to the test page, so the page sees the
 * backend's own conventions. Preflights are remembered so the ledger can leave them out.
 */
const withHarnessCors =
  (
    handler: Handler,
    preflights: WeakSet<Received>,
    arrival: () => void,
  ): Handler =>
  async (request, context) => {
    const origin = first(request.lines, "origin");
    const preflightMethod = first(
      request.lines,
      "access-control-request-method",
    );
    if (request.method === "OPTIONS" && preflightMethod !== undefined) {
      preflights.add(request);
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
          ["Access-Control-Max-Age", "0"],
          ["Vary", "Origin"],
        ],
      };
    }
    arrival();
    const reply = await handler(request, context);
    if (origin === undefined) return reply;
    const lines = (reply.lines ?? []).filter(
      ([name]) => !name.toLowerCase().startsWith("access-control-"),
    );
    const exposed = [...new Set(lines.map(([name]) => name))];
    return {
      ...reply,
      lines: [
        ...lines,
        ["Access-Control-Allow-Origin", origin],
        ["Access-Control-Allow-Credentials", "true"],
        ...(exposed.length === 0
          ? []
          : [["Access-Control-Expose-Headers", exposed.join(", ")] as const]),
        ["Vary", "Origin"],
      ],
    };
  };

interface Running {
  readonly server: Server;
  readonly scope: Scope.Closeable;
  readonly preflights: WeakSet<Received>;
  readonly waiters: Array<{
    readonly count: number;
    readonly resolve: () => void;
  }>;
}

const recorded = (running: Running): ReadonlyArray<Recorded> =>
  running.server.ledger
    .filter((received) => !running.preflights.has(received))
    .map((received) => ({
      method: received.method,
      target: received.target,
      lines: received.lines,
      body: received.body,
      aborted: received.aborted(),
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
  ) => {
    const id = String(++next);
    const preflights = new WeakSet<Received>();
    const waiters: Running["waiters"] = [];
    const scope = await Effect.runPromise(Scope.make());
    let entry: Running | undefined;
    const arrival = () =>
      queueMicrotask(() => {
        if (entry === undefined) return;
        const count = recorded(entry).length;
        for (const waiter of waiters.splice(0))
          if (count >= waiter.count) waiter.resolve();
          else waiters.push(waiter);
      });
    const inner = await loadHandler(name, options);
    const handler: Handler =
      cors === "harness"
        ? withHarnessCors(inner, preflights, arrival)
        : (request, context) => {
            arrival();
            return inner(request, context);
          };
    const server = await Effect.runPromise(
      serve(handler).pipe(Scope.provide(scope)),
    );
    entry = { server, scope, preflights, waiters };
    running.set(id, entry);
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
          };
          return reply(
            200,
            await start(body.name, body.options, body.cors ?? "harness"),
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
          if (recorded(entry).length < count)
            await new Promise<void>((resolve) =>
              entry.waiters.push({ count, resolve }),
            );
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
