import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  type AddressInfo,
  connect,
  createServer as createTcpServer,
  type Server,
  type Socket,
} from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Exchange, WireRequest } from "./evidence.js";

/**
 * The Node side of both lanes. It runs the Rust host as a child process, opens a recording proxy in
 * front of each of a table's cleartext listeners, and answers the tests over HTTP, so a test in a
 * browser page reaches it the same way as one in Node.
 */

interface Ports {
  readonly plain: number;
  readonly http: number;
  readonly https: number;
}

/** The commands of `host/src/main.rs`, one JSON line each way. */
class Host {
  readonly #process: ChildProcess;
  readonly #waiting = new Map<
    number,
    (answer: { ok?: unknown; error?: string }) => void
  >();
  #next = 1;

  constructor(executable: string, directory: string) {
    this.#process = spawn(executable, ["serve", directory], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    createInterface({ input: this.#process.stdout! }).on("line", (line) => {
      const answer = JSON.parse(line) as {
        id: number;
        ok?: unknown;
        error?: string;
      };
      this.#waiting.get(answer.id)?.(answer);
      this.#waiting.delete(answer.id);
    });
    this.#process.on("exit", (code) => {
      for (const resume of this.#waiting.values())
        resume({ error: `the host exited with ${code}` });
    });
  }

  /** Perform a command, resolving with its id and result, or rejecting with the host's reason. */
  perform(command: object): Promise<{ id: number; value: unknown }> {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, (answer) =>
        answer.error === undefined
          ? resolve({ id, value: answer.ok })
          : reject(new Error(answer.error)),
      );
      this.#process.stdin!.write(`${JSON.stringify({ id, ...command })}\n`);
    });
  }

  stop(): void {
    this.#process.stdin!.end();
  }
}

/** The connection preface of HTTP/2 with prior knowledge (RFC 9113 section 3.4). */
const preface = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", "latin1");

/**
 * Read request heads out of what a client wrote to one connection. Bodies are skipped by
 * `Content-Length`, or up to the last chunk of a chunked body, which is all this suite sends. A
 * connection that begins with the HTTP/2 preface is recorded by the preface's request line alone,
 * `PRI * HTTP/2.0`: HTTP/2 frames are not read here, and the HTTP/2 provider records the fields it
 * wrote instead.
 */
class Heads {
  #buffer = Buffer.alloc(0);
  #skip = 0;
  #chunked = false;
  /** Whether the connection's first bytes are still to be compared with the preface. */
  #first = true;
  #http2 = false;

  constructor(readonly found: (head: string) => void) {}

  push(chunk: Buffer): void {
    if (this.#http2) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#first) {
      const length = Math.min(this.#buffer.length, preface.length);
      if (
        this.#buffer.subarray(0, length).equals(preface.subarray(0, length))
      ) {
        if (length < preface.length) return;
        this.#http2 = true;
        this.#buffer = Buffer.alloc(0);
        this.found("PRI * HTTP/2.0\r\n");
        return;
      }
      this.#first = false;
    }
    for (;;) {
      if (this.#skip > 0) {
        const skipped = Math.min(this.#skip, this.#buffer.length);
        this.#buffer = this.#buffer.subarray(skipped);
        this.#skip -= skipped;
        if (this.#skip > 0) return;
      }
      if (this.#chunked) {
        const end = this.#buffer.indexOf("0\r\n\r\n");
        if (end < 0) return;
        this.#buffer = this.#buffer.subarray(end + 5);
        this.#chunked = false;
      }
      const end = this.#buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = this.#buffer.subarray(0, end + 2).toString("latin1");
      this.#buffer = this.#buffer.subarray(end + 4);
      const lines = head.split("\r\n").slice(1, -1);
      const field = (name: string) =>
        lines
          .find((line) => line.toLowerCase().startsWith(`${name}:`))
          ?.slice(name.length + 1);
      this.#skip = Number(field("content-length")?.trim() ?? 0) || 0;
      this.#chunked =
        field("transfer-encoding")?.toLowerCase().includes("chunked") ?? false;
      this.found(head);
    }
  }
}

const parse = (
  listener: WireRequest["listener"],
  connection: number,
  head: string,
): WireRequest => {
  const [line = "", ...rest] = head.slice(0, -2).split("\r\n");
  const first = line.indexOf(" ");
  const last = line.lastIndexOf(" ");
  const lines = rest.map((text): readonly [string, string] => {
    const colon = text.indexOf(":");
    return colon < 0
      ? [text, ""]
      : [text.slice(0, colon), text.slice(colon + 1).trim()];
  });
  const method = line.slice(0, first);
  return {
    listener,
    connection,
    head,
    method,
    target: line.slice(first + 1, last),
    protocol: line.slice(last + 1),
    lines,
    preflight:
      method === "OPTIONS" &&
      lines.some(
        ([name]) => name.toLowerCase() === "access-control-request-method",
      ),
  };
};

interface Open {
  readonly ports: Ports;
  readonly wire: Array<WireRequest>;
  readonly proxies: ReadonlyArray<Server>;
  /** How many exchanges and wire requests the tests have taken so far. */
  readonly taken: { exchanges: number; wire: number };
}

/** A proxy to `port` that records what each client writes, and passes both directions on. */
const recordingProxy = (
  port: number,
  listener: WireRequest["listener"],
  wire: Array<WireRequest>,
  connections: { count: number },
): Promise<Server> =>
  new Promise((resolve) => {
    const proxy = createTcpServer((client) => {
      const connection = ++connections.count;
      const heads = new Heads((head) =>
        wire.push(parse(listener, connection, head)),
      );
      const upstream = connect(port, "127.0.0.1");
      sockets.add(client).add(upstream);
      client.on("data", (chunk: Buffer) => {
        heads.push(chunk);
        upstream.write(chunk);
      });
      client.on("end", () => upstream.end());
      upstream.pipe(client);
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on("error", close);
      upstream.on("error", close);
      client.on("close", () => {
        upstream.end();
        sockets.delete(client);
      });
      upstream.on("close", () => sockets.delete(upstream));
    });
    const sockets = new Set<Socket>();
    proxy.on("close", () => {
      for (const socket of sockets) socket.destroy();
    });
    proxy.listen(0, "127.0.0.1", () => resolve(proxy));
  });

const port = (server: Server) => (server.address() as AddressInfo).port;

export interface Control {
  readonly url: string;
  readonly close: () => Promise<void>;
}

const body = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const reply = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  response.end(JSON.stringify(value ?? null));
};

/**
 * Start the host and the control server.
 *
 * - `POST /tables` with a route table opens it, and answers its id and origins;
 * - `GET /tables/<id>` answers its exchanges and what crossed its cleartext sockets since the last
 *   `GET`;
 * - `DELETE /tables/<id>` closes it.
 */
export const startControl = async (root: URL): Promise<Control> => {
  const built = JSON.parse(
    readFileSync(new URL(".host/BUILT", root), "utf8"),
  ) as {
    executable: string;
  };
  const host = new Host(
    built.executable,
    fileURLToPath(new URL(".host", root)),
  );
  const tables = new Map<number, Open>();

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, DELETE",
        "access-control-allow-headers": "content-type",
      });
      return response.end();
    }
    const [, collection, id] = (request.url ?? "").split("/");
    if (collection !== "tables")
      return reply(response, 404, "no such resource");
    if (request.method === "POST" && id === undefined) {
      const definition: unknown = JSON.parse(await body(request));
      const { id: table, value } = await host.perform({
        do: "open",
        definition,
      });
      const { ports } = value as { ports: Ports };
      const wire: Array<WireRequest> = [];
      const connections = { count: 0 };
      const proxies = await Promise.all([
        recordingProxy(ports.plain, "plain", wire, connections),
        recordingProxy(ports.http, "http", wire, connections),
      ]);
      tables.set(table, {
        ports,
        wire,
        proxies,
        taken: { exchanges: 0, wire: 0 },
      });
      return reply(response, 200, {
        id: table,
        origins: {
          plain: `http://127.0.0.1:${port(proxies[0]!)}`,
          http: `http://127.0.0.1:${port(proxies[1]!)}`,
          https: `https://127.0.0.1:${ports.https}`,
        },
        ports,
      });
    }
    const open = tables.get(Number(id));
    if (open === undefined) return reply(response, 404, `no table ${id}`);
    if (request.method === "GET") {
      const { taken } = open;
      const { value } = await host.perform({
        do: "ledger",
        table: Number(id),
        from: taken.exchanges,
      });
      const exchanges = value as ReadonlyArray<Exchange>;
      const wire = open.wire.slice(taken.wire);
      taken.exchanges += exchanges.length;
      taken.wire += wire.length;
      return reply(response, 200, { exchanges, wire });
    }
    if (request.method === "DELETE") {
      tables.delete(Number(id));
      for (const proxy of open.proxies) proxy.close();
      await host.perform({ do: "close", table: Number(id) });
      return reply(response, 200, null);
    }
    return reply(response, 405, "no such method");
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) =>
      reply(
        response,
        500,
        error instanceof Error ? error.message : String(error),
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      for (const open of tables.values())
        for (const proxy of open.proxies) proxy.close();
      host.stop();
      await new Promise((resolve) => server.close(resolve));
    },
  };
};
