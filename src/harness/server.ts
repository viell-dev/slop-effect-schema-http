import { createServer, type IncomingMessage, ServerResponse } from "node:http";
import {
  type AddressInfo,
  createServer as createSocketServer,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { Effect, type Scope } from "effect";

/** Header lines in order, with their original spelling and repetition. */
export type Lines = ReadonlyArray<readonly [string, string]>;

/**
 * What listens for a backend. `"http"`, the default, is `node:http`, whose parser refuses or reshapes
 * some requests before any handler sees them. `"socket"` is a plain `node:net` listener that refuses
 * nothing and reads the bytes itself; `socketListener` below gives its rules.
 */
export type Listener = "http" | "socket";

/** One request exactly as the server's socket received it. */
export interface Received {
  readonly method: string;
  /**
   * The request target as sent, not decoded, one character per byte: normally the path and query,
   * and anything else the client wrote there, such as a fragment, `*` or a whole URL.
   */
  readonly target: string;
  readonly lines: Lines;
  /**
   * The request line and header lines as they arrived, one character per byte, up to the blank line
   * that ends them. Only the socket listener has this; `node:http` keeps only what it parsed.
   */
  readonly head?: string | undefined;
  /**
   * The body bytes received so far. A handler always sees the complete body; a request whose
   * client disconnected mid-body keeps the bytes that arrived.
   */
  readonly body: Uint8Array;
  /** Whether the client closed the connection before the server finished its reply. */
  readonly aborted: () => boolean;
}

/** A reply written to the socket as given: status text, raw header lines, and body bytes. */
export interface Reply {
  readonly status: number;
  /** Defaults to Node's standard text for the status. */
  readonly statusText?: string;
  readonly lines?: Lines;
  readonly body?: string | Uint8Array;
}

/** What a handler sees besides the request: its abort signal and the server's base URL. */
export interface Context {
  /** Aborted when the client closes the connection before the reply ends. */
  readonly signal: AbortSignal;
  readonly origin: string;
}

export type Handler = (
  request: Received,
  context: Context,
) => Reply | Promise<Reply>;

export interface Server {
  /** `http://127.0.0.1:<port>`, without a trailing slash. */
  readonly origin: string;
  /**
   * Every request in arrival order, recorded as soon as its head arrives: before its body is
   * complete and before the handler runs, so an upload cut off mid-body is recorded too.
   */
  readonly ledger: ReadonlyArray<Received>;
  /** Resolves once at least `count` requests, of those `include` accepts, have arrived. */
  readonly arrived: (
    count: number,
    include?: (received: Received) => boolean,
  ) => Promise<void>;
}

/** Look up the first value of a header in received lines, case-insensitively. */
export const header = (lines: Lines, name: string): string | undefined =>
  lines.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

/** Every value of a header in received lines, one per physical line. */
export const headerValues = (
  lines: Lines,
  name: string,
): ReadonlyArray<string> =>
  lines
    .filter(([key]) => key.toLowerCase() === name.toLowerCase())
    .map(([, value]) => value);

/** The decoded body as text, UTF-8 unless a decoder is given. */
export const text = (
  received: Received,
  decoder: TextDecoder = new TextDecoder(),
): string => decoder.decode(received.body);

/** The query parameters of the received target, in order and with repetition. */
export const query = (received: Received): URLSearchParams =>
  new URL(received.target, "http://placeholder").searchParams;

/** The received path, not decoded: the target up to its query or fragment. */
export const path = (received: Received): string =>
  received.target.split(/[?#]/)[0] ?? "";

const pairs = (raw: ReadonlyArray<string>): Lines => {
  const lines: Array<readonly [string, string]> = [];
  for (let index = 0; index + 1 < raw.length; index += 2)
    lines.push([raw[index]!, raw[index + 1]!]);
  return lines;
};

/** Read the body into `chunks` as it arrives; rejects when the request fails before its end. */
const collect = (
  request: IncomingMessage,
  chunks: Array<Buffer>,
): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    request.on("error", reject);
  });

const write = (response: ServerResponse, reply: Reply): void => {
  const flat = (reply.lines ?? []).flatMap(([name, value]) => [name, value]);
  if (reply.statusText === undefined) response.writeHead(reply.status, flat);
  else response.writeHead(reply.status, reply.statusText, flat);
  response.end(reply.body);
};

/** What a listener needs from `serve`. */
interface Exchange {
  /** Put a request on the ledger, as soon as its head has arrived. */
  readonly record: (received: Received) => void;
  /** Run the handler on a complete request, and pass on its reply unless the client has gone. */
  readonly answer: (
    received: Received,
    signal: AbortSignal,
    reply: (reply: Reply) => void,
  ) => Promise<void>;
}

interface Listening {
  readonly server: NetServer;
  readonly closeConnections: () => void;
}

const httpListener = ({ record, answer }: Exchange): Listening => {
  const server = createServer((request, response) => {
    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) controller.abort();
    });
    // Recorded at arrival; the body getter shows the bytes received so far.
    const chunks: Array<Buffer> = [];
    let complete: Uint8Array | undefined;
    const received: Received = {
      method: request.method ?? "",
      target: request.url ?? "",
      lines: pairs(request.rawHeaders),
      get body() {
        return complete ?? new Uint8Array(Buffer.concat(chunks));
      },
      aborted: () => controller.signal.aborted,
    };
    record(received);
    const exchange = async () => {
      try {
        complete = await collect(request, chunks);
      } catch {
        // The client went away mid-body: the entry keeps what arrived and reads as
        // aborted, and no handler sees a partial request.
        controller.abort();
        return;
      }
      await answer(received, controller.signal, (reply) =>
        write(response, reply),
      );
    };
    // Whatever still fails, such as a second write after a partial one, ends the
    // connection rather than escaping as an unhandled rejection.
    exchange().catch(() => response.destroy());
  });
  return { server, closeConnections: () => server.closeAllConnections() };
};

/**
 * Read a head the way a server that refuses nothing has to. The method runs to the first space, and
 * the target from there to a final ` HTTP/<major>.<minor>`, or to the end of the line without one.
 * A header name runs to its line's first colon, and a line without a colon is a name with an empty
 * value. A value loses its surrounding spaces and tabs, as in `node:http`.
 */
const readHead = (head: string) => {
  const [requestLine = "", ...fields] = head.split("\r\n");
  const space = requestLine.indexOf(" ");
  return {
    method: space < 0 ? requestLine : requestLine.slice(0, space),
    target:
      space < 0
        ? ""
        : requestLine.slice(space + 1).replace(/ HTTP\/\d\.\d$/, ""),
    lines: fields.map((field): readonly [string, string] => {
      const colon = field.indexOf(":");
      return colon < 0
        ? [field, ""]
        : [
            field.slice(0, colon),
            field.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, ""),
          ];
    }),
  };
};

/**
 * A plain socket listener, for requests `node:http` would refuse or reshape, such as a space in the
 * target, an unknown method or `CONNECT`. It serves one request per connection. The head ends at
 * the first CRLF CRLF, and only a whole number in `Content-Length` frames a body; any other bytes
 * after the head are ignored. Bytes become characters one for one, as `node:http` decodes the
 * target and header lines. The reply goes through Node's own `ServerResponse`, so it has the same
 * lines and framing as under `node:http`, except `Connection: close`.
 */
const socketListener = ({ record, answer }: Exchange): Listening => {
  const open = new Set<Socket>();
  const server = createSocketServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    // A reset ends the connection like any other disconnect, which the reply's close event reports.
    socket.on("error", () => undefined);
    let start = Buffer.alloc(0);
    const readStart = (chunk: Buffer) => {
      start = Buffer.concat([start, chunk]);
      const end = start.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", readStart);
      const head = start.toString("latin1", 0, end);
      const { method, target, lines } = readHead(head);
      const declared = header(lines, "content-length") ?? "";
      const length = /^\d+$/.test(declared) ? Number(declared) : 0;
      const response = new ServerResponse({
        method,
        httpVersionMajor: 1,
        httpVersionMinor: 1,
      } as IncomingMessage);
      response.shouldKeepAlive = false;
      response.assignSocket(socket);
      response.on("finish", () => socket.end());
      const controller = new AbortController();
      response.on("close", () => {
        if (!response.writableFinished) controller.abort();
      });
      let body = start.subarray(end + 4, end + 4 + length);
      const received: Received = {
        method,
        target,
        lines,
        head,
        get body() {
          return new Uint8Array(body);
        },
        aborted: () => controller.signal.aborted,
      };
      record(received);
      const exchange = () => {
        // As under `node:http`, whatever still fails ends the connection.
        answer(received, controller.signal, (reply) =>
          write(response, reply),
        ).catch(() => socket.destroy());
      };
      if (body.length >= length) return exchange();
      const readBody = (more: Buffer) => {
        body = Buffer.concat([body, more]).subarray(0, length);
        if (body.length < length) return;
        socket.off("data", readBody);
        exchange();
      };
      socket.on("data", readBody);
    };
    socket.on("data", readStart);
  });
  return {
    server,
    closeConnections: () => {
      for (const socket of open) socket.destroy();
    },
  };
};

/**
 * Serve `handler` on an ephemeral loopback port for the current scope. Closing the scope closes
 * every open connection, including held-open requests. `host` defaults to `127.0.0.1`; any address
 * in `127.0.0.0/8` is loopback on Linux and Windows. `listener` defaults to `node:http`.
 */
export const serve = (
  handler: Handler,
  host = "127.0.0.1",
  listener: Listener = "http",
): Effect.Effect<Server, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<Server & { readonly close: () => Promise<void> }>(
          (resolve) => {
            const ledger: Array<Received> = [];
            const waiting: Array<{
              readonly count: number;
              readonly include: (received: Received) => boolean;
              readonly resolve: () => void;
            }> = [];
            const reached = (
              count: number,
              include: (received: Received) => boolean,
            ) => ledger.filter(include).length >= count;
            let origin = "";
            const exchange: Exchange = {
              record: (received) => {
                ledger.push(received);
                for (const waiter of waiting.splice(0))
                  if (reached(waiter.count, waiter.include)) waiter.resolve();
                  else waiting.push(waiter);
              },
              answer: async (received, signal, reply) => {
                try {
                  const answered = await handler(received, { signal, origin });
                  if (!signal.aborted) reply(answered);
                } catch (cause) {
                  if (!signal.aborted)
                    reply({
                      status: 599,
                      statusText: "Fixture Failure",
                      lines: [["Content-Type", "text/plain"]],
                      body: `fixture handler threw: ${String(cause)}`,
                    });
                }
              },
            };
            const { server, closeConnections } =
              listener === "http"
                ? httpListener(exchange)
                : socketListener(exchange);
            server.listen(0, host, () => {
              const { port } = server.address() as AddressInfo;
              origin = `http://${host}:${port}`;
              resolve({
                origin,
                ledger,
                arrived: (count, include = () => true) =>
                  reached(count, include)
                    ? Promise.resolve()
                    : new Promise((done) =>
                        waiting.push({ count, include, resolve: done }),
                      ),
                close: () =>
                  new Promise((done) => {
                    closeConnections();
                    server.close(() => done());
                  }),
              });
            });
          },
        ),
    ),
    (server) => Effect.promise(() => server.close()),
  );
