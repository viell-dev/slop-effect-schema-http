import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Effect, type Scope } from "effect";

/** Header lines in order, with their original spelling and repetition. */
export type Lines = ReadonlyArray<readonly [string, string]>;

/** One request exactly as the server's socket received it. */
export interface Received {
  readonly method: string;
  /** The request target as sent: path and query, not decoded. */
  readonly target: string;
  readonly lines: Lines;
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

/** The received path, not decoded. */
export const path = (received: Received): string =>
  received.target.split("?")[0] ?? "";

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

/**
 * Serve `handler` on an ephemeral loopback port for the current scope. Closing the scope closes
 * every open connection, including held-open requests. `host` defaults to `127.0.0.1`; any address
 * in `127.0.0.0/8` is loopback on Linux and Windows.
 */
export const serve = (
  handler: Handler,
  host = "127.0.0.1",
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
              ledger.push(received);
              for (const waiter of waiting.splice(0))
                if (reached(waiter.count, waiter.include)) waiter.resolve();
                else waiting.push(waiter);
              const exchange = async () => {
                try {
                  complete = await collect(request, chunks);
                } catch {
                  // The client went away mid-body: the entry keeps what arrived and reads as
                  // aborted, and no handler sees a partial request.
                  controller.abort();
                  return;
                }
                try {
                  const reply = await handler(received, {
                    signal: controller.signal,
                    origin,
                  });
                  if (!controller.signal.aborted) write(response, reply);
                } catch (cause) {
                  if (!controller.signal.aborted)
                    write(response, {
                      status: 599,
                      statusText: "Fixture Failure",
                      lines: [["Content-Type", "text/plain"]],
                      body: `fixture handler threw: ${String(cause)}`,
                    });
                }
              };
              // Whatever still fails, such as a second write after a partial one, ends the
              // connection rather than escaping as an unhandled rejection.
              exchange().catch(() => response.destroy());
            });
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
                    server.closeAllConnections();
                    server.close(() => done());
                  }),
              });
            });
          },
        ),
    ),
    (server) => Effect.promise(() => server.close()),
  );
