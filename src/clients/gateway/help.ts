/**
 * The help topics. `help.cgi` answers one `OK|<topic>|<section>|<text>` line for each section it
 * covers, or one `ERROR|<code>|<message>` line, in HTTP 200 like every pipe reply. Whether that is
 * the whole topic or a single section depends on a fragment on the request line, which only a
 * client that writes its own request line can send, so one reader takes both.
 *
 * The declarations below are the ways a consumer can state a fragment, and `go.cgi`'s link to a
 * section (EXT-9). Each takes the client middleware to apply last, so that a test can see what the
 * client received, and leaves the client itself to the caller: what arrives is the provider's
 * doing.
 */
import { Schema, SchemaTransformation } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import { ErrorLine, GatewayError, PipeLine } from "./pipe.js";

const Section = Schema.Struct({
  topic: Schema.String,
  section: Schema.String,
  text: Schema.String,
});
export type Section = typeof Section.Type;

const SectionFields = Schema.Tuple([
  Schema.Literal("OK"),
  Schema.NonEmptyString,
  Schema.NonEmptyString,
  Schema.String,
]);

/** `OK|<topic>|<section>|<text>`. */
export const SectionLine = SectionFields.pipe(
  Schema.decodeTo(
    Section,
    SchemaTransformation.transform<Section, (typeof SectionFields)["Type"]>({
      decode: ([, topic, section, text]) => ({ topic, section, text }),
      encode: ({ topic, section, text }) => ["OK", topic, section, text],
    }),
  ),
);

/**
 * A reply cut after each `\n`, each line kept whole so that `PipeLine` judges it. Text after the
 * last `\n` stays a line of its own, which `PipeLine` refuses, and no text is no lines.
 */
const Lines = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Array(Schema.String),
    SchemaTransformation.transform<ReadonlyArray<string>, string>({
      decode: (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [],
      encode: (lines) => lines.join(""),
    }),
  ),
);

const SectionLines = Schema.NonEmptyArray(
  PipeLine.pipe(Schema.decodeTo(SectionLine)),
);

/** The sections a reply covers, in the order they arrived. */
export const Help = Schema.TaggedStruct("Help", {
  sections: Schema.NonEmptyArray(Section),
});
export type Help = typeof Help.Type;

const HelpFromLines = SectionLines.pipe(
  Schema.decodeTo(
    Help,
    SchemaTransformation.transform<Help, (typeof SectionLines)["Type"]>({
      decode: (sections) => ({ _tag: "Help", sections }),
      encode: ({ sections }) => sections,
    }),
  ),
);

const OneErrorLine = Schema.Tuple([PipeLine.pipe(Schema.decodeTo(ErrorLine))]);

const ErrorFromLines = OneErrorLine.pipe(
  Schema.decodeTo(
    GatewayError,
    SchemaTransformation.transform<GatewayError, (typeof OneErrorLine)["Type"]>(
      {
        decode: ([error]) => error,
        encode: (error) => [error],
      },
    ),
  ),
);

/**
 * A whole reply: one or more section lines, or exactly one ERROR line. `PipeLine` allows no `|` in
 * a field, so a message echoing a `|` from the target is a decode error here, as anywhere else.
 */
export const HelpReply = Lines.pipe(
  Schema.decodeTo(Schema.Union([HelpFromLines, ErrorFromLines])),
);

/** Every help reply, section or refusal, is HTTP 200. */
export const response = Response.status(
  200,
  Body.text.pipe(Body.schema(HelpReply)),
);

/** Client middleware to apply last. */
type Last = (client: HttpClient.HttpClient) => HttpClient.HttpClient;

const ACCOUNTS = "/cgi-bin/help.cgi/accounts";

const pathOutput = Request.get("").pipe(
  Request.path(Schema.String, (path) => path),
);

/** The fragment in the base URL, which the library moves to the request's `hash`. */
export const inBaseUrl = (origin: string, last: Last) =>
  Operation.make(
    Request.get("").pipe(Request.baseUrl(`${origin}${ACCOUNTS}#closing`)),
    response,
    { transformClient: last },
  ).execute(undefined);

/** The fragment in path output, which the library moves to the request's `hash`. */
export const inPathOutput = (origin: string, last: Last) =>
  Operation.make(pathOutput.pipe(Request.baseUrl(origin)), response, {
    transformClient: last,
  }).execute({ path: `${ACCOUNTS}#closing` });

/** The fragment in path output with a query, which goes before it. */
export const inPathOutputWithQuery = (origin: string, last: Last) =>
  Operation.make(
    pathOutput.pipe(Request.baseUrl(origin), Request.setQuery("lang", "de")),
    response,
    { transformClient: last },
  ).execute({ path: `${ACCOUNTS}#closing` });

/** The fragment in the constructor, which stays on the request as its `hash`. */
export const inConstructor = (origin: string, last: Last) =>
  Operation.make(Request.get(`${origin}${ACCOUNTS}#closing`), response, {
    transformClient: last,
  }).execute(undefined);

/** The fragment set by client middleware, as the request's `hash`, with a query beside it. */
export const inMiddleware = (origin: string, last: Last) =>
  Operation.make(
    Request.get(`${origin}${ACCOUNTS}`).pipe(Request.setQuery("lang", "de")),
    response,
    {
      transformClient: (client) =>
        last(
          HttpClient.mapRequest(client, HttpClientRequest.setHash("closing")),
        ),
    },
  ).execute(undefined);

/** `go.cgi`'s link to the `closing` section. Following its 302 is up to the client. */
export const throughGo = (origin: string, last: Last) =>
  Operation.make(
    Request.get(`${origin}/cgi-bin/go.cgi`).pipe(
      Request.setQuery("section", "closing"),
    ),
    response,
    { transformClient: last },
  ).execute(undefined);
