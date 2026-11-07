import {
  type ClientRequest,
  type IncomingMessage,
  request as send,
} from "node:http";
import { connect, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { Effect, Layer, Option, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
  UrlParams,
} from "effect/http";
import { Transport } from "viell-effect-schema-http";
import type { RawOptions } from "./lane.js";

/**
 * Effect's Fetch provider over Node's global `fetch`. Fetch joins repeated request header lines with
 * `, `, sends no cookies by itself in Node, and follows redirects unless told otherwise.
 */
export const fetchClient: Layer.Layer<HttpClient.HttpClient> =
  FetchHttpClient.layer;

const bodyBytes = (
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<{
  readonly bytes: Uint8Array | undefined;
  readonly contentType: string | undefined;
}> => {
  const body = request.body;
  switch (body._tag) {
    case "Empty":
      return Effect.succeed({ bytes: undefined, contentType: undefined });
    case "Uint8Array":
      return Effect.succeed({ bytes: body.body, contentType: undefined });
    case "Raw":
      return Effect.succeed({
        bytes:
          typeof body.body === "string"
            ? new TextEncoder().encode(body.body)
            : (body.body as Uint8Array),
        contentType: undefined,
      });
    case "FormData":
      // Let the platform serialize the multipart body and choose its boundary.
      return Effect.promise(async () => {
        const web = new Request("http://serializer.invalid/", {
          method: "POST",
          body: body.formData,
        });
        return {
          bytes: new Uint8Array(await web.arrayBuffer()),
          contentType: web.headers.get("content-type") ?? undefined,
        };
      });
    case "Stream":
      return Stream.runCollect(body.stream).pipe(
        Effect.map((chunks) => {
          const all = Array.from(chunks);
          const bytes = new Uint8Array(
            all.reduce((size, chunk) => size + chunk.length, 0),
          );
          let offset = 0;
          for (const chunk of all) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          return { bytes, contentType: undefined };
        }),
        Effect.orDie,
      );
  }
};

const transportError = (
  request: HttpClientRequest.HttpClientRequest,
  cause: unknown,
) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, cause }),
  });

/** The Fetch standard's null body statuses: a `Response` with one of them must have no body. */
const nullBodyStatuses: ReadonlySet<number> = new Set([
  101, 103, 204, 205, 304,
]);

/**
 * The lines to send: the request's own, after the `Host` HTTP/1.1 requires and followed by the
 * body's type and length, each added only when the request declares none. Node adds no default
 * headers to raw header lines, and a socket adds nothing at all.
 */
const withFraming = (
  lines: Transport.Lines,
  host: string,
  bytes: Uint8Array | undefined,
  contentType: string | undefined,
): Transport.Lines => {
  const outgoing: Array<readonly [string, string]> = lines.some(
    ([name]) => name.toLowerCase() === "host",
  )
    ? [...lines]
    : [["host", host], ...lines];
  if (
    contentType !== undefined &&
    !outgoing.some(([name]) => name.toLowerCase() === "content-type")
  )
    outgoing.push(["content-type", contentType]);
  if (
    bytes !== undefined &&
    !outgoing.some(([name]) => name.toLowerCase() === "content-length")
  )
    outgoing.push(["content-length", String(bytes.length)]);
  return outgoing;
};

type Resume = (
  outcome: Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError
  >,
) => void;

/** Read a parsed response to its end, and resume with it, its raw lines attached. */
const readResponse = (
  request: HttpClientRequest.HttpClientRequest,
  incoming: IncomingMessage,
  resume: Resume,
): void => {
  const chunks: Array<Buffer> = [];
  incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
  incoming.on("error", (cause) =>
    resume(Effect.fail(transportError(request, cause))),
  );
  incoming.on("end", () => {
    const raw = incoming.rawHeaders;
    const responseLines: Array<readonly [string, string]> = [];
    for (let index = 0; index + 1 < raw.length; index += 2)
      responseLines.push([raw[index]!, raw[index + 1]!]);
    const status = incoming.statusCode ?? 0;
    const empty = nullBodyStatuses.has(status) || request.method === "HEAD";
    let response: HttpClientResponse.HttpClientResponse;
    try {
      const web = new Response(
        empty ? null : new Uint8Array(Buffer.concat(chunks)),
        {
          status,
          statusText: incoming.statusMessage ?? "",
          headers: responseLines.map(([name, value]): [string, string] => [
            name,
            value,
          ]),
        },
      );
      response = Transport.withResponseHeaders(
        HttpClientResponse.fromWeb(request, web),
        responseLines,
      );
    } catch (cause) {
      // A response the Fetch API cannot represent, such as a status outside 200–599,
      // fails the request as a transport error instead of throwing in this callback.
      return resume(Effect.fail(transportError(request, cause)));
    }
    resume(Effect.succeed(response));
  });
};

/**
 * Fail a request whose response is a change of protocol. `node:http` treats every answer to
 * `CONNECT`, whatever its status, and a `101` with `Upgrade`, as handing over the connection: it
 * emits neither `response` nor `error`, and with no listener it just drops the socket, so the
 * request would never settle. These providers read a response and own no tunnel, so the connection
 * ends here, as a transport failure that names what the server answered.
 */
const refuseHandover = (
  outgoing: ClientRequest,
  request: HttpClientRequest.HttpClientRequest,
  resume: Resume,
): void => {
  const refuse = (incoming: IncomingMessage, connection: Duplex) => {
    connection.destroy();
    resume(
      Effect.fail(
        transportError(
          request,
          new Error(
            `${request.method} was answered ${incoming.statusCode ?? 0} with a change of protocol, which this provider does not take`,
          ),
        ),
      ),
    );
  };
  outgoing.on("connect", refuse);
  outgoing.on("upgrade", refuse);
};

/**
 * A custom provider over `node:http` that sends the operation's original header lines
 * (`Transport.headerLines`) unjoined, and attaches the response's raw lines to the response with
 * `Transport.withResponseHeaders`. It follows no redirects and keeps no cookies.
 *
 * It takes what `node:http` takes. A request `node:http` refuses to build, such as a method with a
 * space or CR and LF in a header, fails as a transport error with nothing sent, and so does any
 * answer to `CONNECT`, because `refuseHandover` turns it into one. Send those shapes through the
 * raw client, which writes them.
 */
export const linesClient: HttpClient.HttpClient = HttpClient.make(
  (request, url, signal) =>
    Effect.gen(function* () {
      const lines = yield* Transport.headerLines(request);
      const { bytes, contentType } = yield* bodyBytes(request);
      const outgoing = withFraming(lines, url.host, bytes, contentType);
      return yield* Effect.callback<
        HttpClientResponse.HttpClientResponse,
        HttpClientError.HttpClientError
      >((resume) => {
        try {
          const outgoingRequest = send(
            url,
            {
              method: request.method,
              headers: outgoing.flatMap(([name, value]) => [name, value]),
              signal,
            },
            (incoming) => readResponse(request, incoming, resume),
          );
          outgoingRequest.on("error", (cause) =>
            resume(Effect.fail(transportError(request, cause))),
          );
          refuseHandover(outgoingRequest, request, resume);
          outgoingRequest.end(bytes);
        } catch (cause) {
          // `node:http` validates the method and header lines by throwing, not with an `error`
          // event; a throw here would otherwise end the fiber as a defect.
          resume(Effect.fail(transportError(request, cause)));
        }
      });
    }),
);

/** The line-preserving provider as a layer. */
export const linesLayer: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  linesClient,
);

/**
 * The request target, from the request's own text and without parsing it. Removing the provider's
 * origin leaves what followed it; a URL that does not start with the origin stays whole. Parameters
 * that client middleware put in `urlParams` go before any `#` in that text, where every client built
 * with `HttpClient.make` puts them, and `#` and the hash follow when there is one. A URL that is only
 * the origin leaves an empty target, so write `${origin}/` for the root.
 */
const rawTarget = (
  origin: string,
  request: HttpClientRequest.HttpClientRequest,
): string => {
  const rest = request.url.startsWith(origin)
    ? request.url.slice(origin.length)
    : undefined;
  // A longer port or host also starts with the origin, and is not this origin.
  const written =
    rest !== undefined && /^(?:[/?#]|$)/.test(rest) ? rest : request.url;
  const mark = written.indexOf("#");
  const before = mark < 0 ? written : written.slice(0, mark);
  const after = mark < 0 ? "" : written.slice(mark);
  const query =
    request.urlParams.params.length === 0
      ? ""
      : `${before.includes("?") ? "&" : "?"}${UrlParams.toString(request.urlParams)}`;
  const hash = Option.match(request.hash, {
    onNone: () => "",
    onSome: (text) => `#${text}`,
  });
  return `${before}${query}${after}${hash}`;
};

/** A header line as bytes: Latin-1, as Fetch and `node:http` write them, or UTF-8 if it does not fit. */
const headerLineBytes = (line: string): Buffer => {
  const latin1 = Buffer.from(line, "latin1");
  return latin1.toString("latin1") === line ? latin1 : Buffer.from(line);
};

/**
 * Read the response from `socket` with Node's own parser, the one the line-preserving provider uses.
 * The parser needs a `ClientRequest`, which needs a connection of its own: this stream, fed by the
 * socket. The stream discards what the `ClientRequest` writes, so the placeholder request never
 * reaches the socket; its method only tells the parser whether a body can follow.
 */
const readFromSocket = (
  socket: Socket,
  request: HttpClientRequest.HttpClientRequest,
  resume: Resume,
): void => {
  const fromSocket = new Duplex({
    read: () => undefined,
    write: (_chunk, _encoding, done) => done(),
  });
  socket.on("data", (chunk) => fromSocket.push(chunk));
  socket.on("end", () => fromSocket.push(null));
  socket.on("error", (cause) => fromSocket.destroy(cause));
  socket.on("close", () => fromSocket.destroy());
  const placeholder = send(
    {
      createConnection: () => fromSocket,
      method: request.method === "HEAD" ? "HEAD" : "GET",
    },
    (incoming) => readResponse(request, incoming, resume),
  );
  placeholder.on("error", (cause) =>
    resume(Effect.fail(transportError(request, cause))),
  );
  refuseHandover(placeholder, request, resume);
  placeholder.end();
};

/**
 * A provider that sends a request exactly as written, for the shapes no standard client sends. It
 * opens one connection per request to `origin`, the only server it can reach, and closes it after
 * the response. `HttpClient.make` parses the URL before its runner is called, so this is built with
 * `HttpClient.makeWith`, and it never parses the request's URL.
 *
 * - **Request line.** The method as given, a space, the target of `rawTarget`, then ` HTTP/1.1`,
 *   written as UTF-8. So `http://<origin>/a/../b` goes out as `/a/../b`, `*` as `*`, and a URL for
 *   anywhere else, or one that cannot be parsed, whole, as an absolute-form target.
 * - **Header lines.** `Transport.headerLines`, as `name: value`, with the lines `withFraming` adds
 *   and nothing else: no `Connection`, `User-Agent` or trace headers, since those come from
 *   `HttpClient.make` and `node:http`. With `framing: false` it adds `Host` alone, so a request that
 *   stopped its automatic `Content-Length` goes out without one, and a body goes out unframed.
 * - **Nothing is refused.** A CR or LF in a method, target, name or value is written like any other
 *   character, so it can end the line it is on. Standard providers refuse these; this one exists
 *   to show what the library passes on, and a real provider that writes bytes must not copy that.
 *
 * It keeps no cookies and follows no redirects. `HttpClient.followRedirects` works around it for
 * redirects to the same origin; a redirect elsewhere would go to `origin` as an absolute-form
 * target. Like the line-preserving provider, it reads the whole response and attaches its raw lines.
 */
export const rawClient = (
  origin: string,
  { framing = true }: RawOptions = {},
): HttpClient.HttpClient => {
  const { host, hostname, port } = new URL(origin);
  return HttpClient.makeWith<
    never,
    never,
    HttpClientError.HttpClientError,
    never
  >(
    (prepared) =>
      Effect.flatMap(prepared, (request) =>
        Effect.gen(function* () {
          const lines = yield* Transport.headerLines(request);
          const { bytes, contentType } = yield* bodyBytes(request);
          const message = Buffer.concat([
            Buffer.from(
              `${request.method} ${rawTarget(origin, request)} HTTP/1.1\r\n`,
            ),
            ...withFraming(
              lines,
              host,
              framing ? bytes : undefined,
              framing ? contentType : undefined,
            ).map(([name, value]) => headerLineBytes(`${name}: ${value}\r\n`)),
            Buffer.from("\r\n"),
            bytes ?? new Uint8Array(),
          ]);
          return yield* Effect.callback<
            HttpClientResponse.HttpClientResponse,
            HttpClientError.HttpClientError
          >((resume) => {
            const socket = connect(Number(port), hostname);
            readFromSocket(socket, request, (outcome) => {
              socket.destroy();
              resume(outcome);
            });
            socket.write(message);
            return Effect.sync(() => socket.destroy());
          });
        }),
      ),
    (request) => Effect.succeed(request),
  );
};

/** The raw provider as a layer. */
export const rawLayer = (
  origin: string,
  options?: RawOptions,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(HttpClient.HttpClient, rawClient(origin, options));
