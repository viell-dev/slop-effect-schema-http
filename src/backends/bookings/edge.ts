/**
 * The edge in front of a region: its rules, which pick at most one fault for a request, and the
 * faults, which write what the client receives instead of the region's answer.
 */
import {
  chunk,
  gzip,
  type GzipDamage,
  lastChunk,
  noReply,
  rawHead,
} from "../../harness/route.js";
import {
  type Lines,
  path,
  type RawReply,
  type RawStep,
  type Received,
  type Reply,
} from "../../harness/server.js";

/** What goes back to the harness: `node:http` writes a `Reply`, and a `RawReply` goes as it is. */
export type Written = Reply | RawReply;

/**
 * What the region said, before anything writes it: A and B on the service page. An export's status
 * line and lines need not parse, so they are kept as text.
 */
export interface Answer {
  /** The status line, without its line end. */
  readonly statusLine: string;
  /** The lines of the head as they go on the wire, without framing or line ends. */
  readonly lines: ReadonlyArray<string>;
  /** B: the body's bytes, without framing. */
  readonly body: Buffer;
  /** The answer complete, with `added` after its own lines and `body` in place of B. */
  readonly whole: (added: Lines, body: Uint8Array) => Written;
}

/** A raw reply a fault can still read as an answer: an export, or a held availability answer. */
export interface Readable extends RawReply {
  readonly answer: Answer;
}

/** A head written here: the answer's status line and lines, then `framing` and the blank line. */
export const head = (answer: Answer, framing: ReadonlyArray<string>): string =>
  [answer.statusLine, ...answer.lines, ...framing, "", ""].join("\r\n");

const bytesOf = (body: Reply["body"]): Buffer =>
  typeof body === "string" ? Buffer.from(body) : Buffer.from(body ?? []);

/** An ordinary reply of the region as an answer. Its `lines` hold no framing. */
export const answerOf = (reply: Reply): Answer => {
  const lines = reply.lines ?? [];
  return {
    // `rawHead` knows the status text; all that follows the status line here is the blank line.
    statusLine: rawHead(reply.status).slice(0, -"\r\n\r\n".length),
    lines: lines.map(([name, value]) => `${name}: ${value}`),
    body: bytesOf(reply.body),
    whole: (added, body) => ({
      status: reply.status,
      lines: [...lines, ...added],
      body,
    }),
  };
};

const firstHalf = (body: Buffer): Buffer =>
  body.subarray(0, Math.floor(body.length / 2));

const secondHalf = (body: Buffer): Buffer =>
  body.subarray(Math.floor(body.length / 2));

/** A chunk, or none for no data: a chunk of nothing would be the last chunk. */
const chunkOf = (data: Uint8Array): ReadonlyArray<RawStep> =>
  data.length === 0 ? [] : [chunk(data)];

const chunked = ["Transfer-Encoding: chunked"];

const contentLength = (length: number): readonly [string, string] => [
  "Content-Length",
  String(length),
];

/** A complete page of the edge's own, on a connection that stays open. */
const page = (
  status: number,
  contentType: string,
  body: string,
  lines: Lines = [],
): Reply => ({
  status,
  lines: [["Content-Type", contentType], ...lines, contentLength(body.length)],
  body,
});

const unavailableBody = "Try again later.";
const retryAfter: Lines = [["Retry-After", "60"]];

/** Faults that need no answer, which are the ones `phase: "before"` takes. */
const standalone: ReadonlyMap<string, () => Written> = new Map<
  string,
  () => Written
>([
  ["closed", () => noReply()],
  ["reset", () => noReply("reset")],
  ["hang", () => noReply("hold")],
  [
    "bad-gateway",
    () => page(502, "text/html", "<html><body>502 Bad Gateway</body></html>"),
  ],
  ["unavailable", () => page(503, "text/plain", unavailableBody, retryAfter)],
  [
    "parked",
    () =>
      page(
        200,
        "text/html",
        "<html><body>This domain is parked.</body></html>",
      ),
  ],
  [
    "other-service",
    () => page(200, "application/json", '{"service":"tides","status":"ok"}'),
  ],
]);

const compressed =
  (damage?: GzipDamage) =>
  (answer: Answer): Written => {
    const stream = gzip(answer.body, damage);
    return answer.whole(
      [["Content-Encoding", "gzip"], contentLength(stream.length)],
      stream,
    );
  };

/** A's head declaring all of B, for the faults that then send only half of it. */
const declared = (answer: Answer) =>
  head(answer, [`Content-Length: ${answer.body.length}`]);

/** Faults that work on the answer. */
const damaging: ReadonlyMap<string, (answer: Answer) => Written> = new Map<
  string,
  (answer: Answer) => Written
>([
  [
    "cut-head",
    (answer: Answer) => ({ head: `${answer.statusLine}\r\nContent-Ty` }),
  ],
  [
    "cut-body",
    (answer: Answer) => ({
      head: declared(answer),
      body: [firstHalf(answer.body)],
    }),
  ],
  [
    "cut-body-reset",
    (answer: Answer) => ({
      head: declared(answer),
      body: [firstHalf(answer.body), { wait: 50 }],
      end: "reset",
    }),
  ],
  [
    "cut-chunked",
    (answer: Answer) => ({
      head: head(answer, chunked),
      body: chunkOf(firstHalf(answer.body)),
    }),
  ],
  [
    "cut-unframed",
    (answer: Answer) => ({
      head: head(answer, ["Connection: close"]),
      body: [firstHalf(answer.body)],
    }),
  ],
  [
    "cut-unavailable",
    () => ({
      head: rawHead(503, [
        ["Content-Type", "text/plain"],
        ...retryAfter,
        contentLength(unavailableBody.length),
      ]),
      body: [unavailableBody.slice(0, 8)],
    }),
  ],
  [
    "bad-chunk",
    (answer: Answer) => ({
      head: head(answer, chunked),
      body: [
        chunk(firstHalf(answer.body), "XX"),
        ...chunkOf(secondHalf(answer.body)),
        lastChunk,
      ],
    }),
  ],
  ["gzip", compressed()],
  ["gzip-magic", compressed("magic")],
  ["gzip-block", compressed("block")],
  ["gzip-checksum", compressed("checksum")],
  ["gzip-truncated", compressed("truncated")],
  ["gzip-trailer", compressed("trailer")],
  [
    "trickle",
    (answer: Answer) => ({
      head: head(answer, [`Content-Length: ${answer.body.length + 1}`]),
      body: [...answer.body].flatMap((byte): ReadonlyArray<RawStep> => [
        Uint8Array.of(byte),
        { wait: 20 },
      ]),
      end: "hold",
    }),
  ],
]);

/** The `edge` test option's rules. */
export interface EdgeRule {
  readonly route: string;
  readonly fault: string;
  readonly phase?: "before" | "after";
  readonly after?: number;
  readonly times?: number;
}

/** The fault a rule applies, and when. */
export type Applied =
  | { readonly phase: "before"; readonly write: () => Written }
  | {
      readonly phase: "after";
      readonly write: (answer: Answer) => Written;
    };

interface Rule {
  readonly route: string;
  readonly after: number;
  readonly times: number;
  readonly applied: Applied;
  seen: number;
  used: number;
}

const isCount = (value: number) => Number.isInteger(value) && value >= 0;

/** One rule of the options, refusing a mistake so that it fails the start. */
const ruleOf = (given: EdgeRule): Rule => {
  const { route, fault, phase = "after", after = 0, times = Infinity } = given;
  const refuse = (why: string) =>
    new Error(`bookings: edge rule ${JSON.stringify(given)}: ${why}`);
  if (route !== "*" && !/^\S+ \S+$/.test(route))
    throw refuse('its route is neither "<METHOD> <path>" nor "*"');
  if (phase !== "before" && phase !== "after")
    throw refuse('its phase is neither "before" nor "after"');
  if (!isCount(after) || (times !== Infinity && !isCount(times)))
    throw refuse("after and times are whole numbers from 0");
  const alone = standalone.get(fault);
  const onAnswer = damaging.get(fault);
  if (alone === undefined && onAnswer === undefined)
    throw refuse("no such fault");
  if (phase === "before" && alone === undefined)
    throw refuse(
      `phase "before" takes only ${[...standalone.keys()].join(", ")}`,
    );
  const applied: Applied =
    phase === "before"
      ? { phase, write: alone! }
      : { phase, write: alone ?? onAnswer! };
  return { route, after, times, applied, seen: 0, used: 0 };
};

/**
 * The rules of a region's edge, which pick the fault for each request. The pick is made once, on
 * arrival, over the whole list whatever a rule's phase, so a rule below the one that applies does
 * not even count the request.
 */
export const edge = (
  given: ReadonlyArray<EdgeRule>,
): ((request: Received) => Applied | undefined) => {
  const rules = given.map(ruleOf);
  return (request) => {
    const route = `${request.method} ${path(request)}`;
    for (const rule of rules) {
      if (rule.route !== "*" && rule.route !== route) continue;
      rule.seen++;
      if (rule.seen <= rule.after || rule.used >= rule.times) continue;
      rule.used++;
      return rule.applied;
    }
    return undefined;
  };
};
