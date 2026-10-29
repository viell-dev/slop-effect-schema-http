/**
 * The portal facade. It shares no code with the SOAP store: it writes its own SOAP request with
 * `node:http`, reads the reply with a few regular expressions, and reaches the store only through
 * `soapOrigin`. It keeps no state.
 *
 * Service documentation: services/soap-proxy.md
 */
import { request as httpRequest } from "node:http";
import { router } from "../harness/route.js";
import type { Context, Handler, Received, Reply } from "../harness/server.js";

/** The test options, documented under "Test options" in the service page. */
export interface Options {
  readonly soapOrigin: string;
}

const STORE_NAMESPACE = "urn:docvault:store:2003";
const SOAP_ENVELOPE = "http://schemas.xmlsoap.org/soap/envelope/";
const PUBLISH = "/DocumentService.svc/Publish";

const first = (request: Received, name: string): string | undefined =>
  request.lines.find(([key]) => key.toLowerCase() === name)?.[1];

/** WCF's help-page style error, the only thing the formatter stage can write. */
const requestError = (status: 400 | 415, detail: string): Reply => ({
  status,
  lines: [["Content-Type", "text/html; charset=UTF-8"]],
  body:
    `<?xml version="1.0" encoding="utf-8"?>\r\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">\r\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Request Error</title></head>` +
    `<body><div id="content"><p class="heading1">Request Error</p>` +
    `<p>The server encountered an error processing the request. The exception message is '${htmlEscape(detail)}'. See server logs for more details.</p>` +
    `</div></body></html>`,
});

const htmlEscape = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&#39;");

/** `enableWebScript`'s JSON fault: always 500, flagged by the `jsonerror` header. */
const jsonError = (exceptionType: string, message: string): Reply => ({
  status: 500,
  lines: [
    ["Content-Type", "application/json; charset=utf-8"],
    ["jsonerror", "true"],
  ],
  body: JSON.stringify({
    ExceptionDetail: null,
    ExceptionType: exceptionType,
    Message: message,
    StackTrace: null,
  }),
});

interface Published {
  readonly Name: string;
  readonly Title: string;
  readonly ContentType: string;
  readonly Content: Uint8Array;
}

/** `DataContractJsonSerializer`'s reading of the wrapped `document` parameter. */
const deserialize = (request: Received): Published | string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(request.body),
    );
  } catch {
    return "The incoming message has an unexpected message format 'Raw'.";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return "OperationFormatter encountered an invalid Message body. Expected to find an attribute with name 'type' and value 'object'.";
  const document = (parsed as Record<string, unknown>)["document"];
  if (
    typeof document !== "object" ||
    document === null ||
    Array.isArray(document)
  )
    return "OperationFormatter could not deserialize any information from the Message because the Message is empty (IsEmpty = true).";
  const contract = document as Record<string, unknown>;
  const text = (
    member: string,
    required: boolean,
  ): string | undefined | null => {
    const value = contract[member];
    if (value === undefined || value === null)
      return required ? null : undefined;
    return typeof value === "string" ? value : null;
  };
  const name = text("Name", true);
  const title = text("Title", false);
  const contentType = text("ContentType", true);
  if (name === null || name === undefined)
    return "The data contract member 'Name' of type 'PublishRequest' is required.";
  if (title === null)
    return "Expecting state 'Element'.. Encountered 'Text' with name '', namespace ''. Member 'Title'.";
  if (contentType === null || contentType === undefined)
    return "The data contract member 'ContentType' of type 'PublishRequest' is required.";
  const content = contract["Content"];
  if (!Array.isArray(content))
    return "The data contract member 'Content' of type 'System.Byte[]' is required.";
  const bytes = new Uint8Array(content.length);
  for (const [index, value] of content.entries()) {
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 255
    )
      return `There was an error deserializing the object of type System.Byte[]. The value '${String(value)}' cannot be parsed as the type 'Byte'.`;
    bytes[index] = value;
  }
  return {
    Name: name,
    Title: title ?? "",
    ContentType: contentType,
    Content: bytes,
  };
};

const xmlEscape = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** The facade's SOAP 1.1 request, written by hand in 2012 from the store's WSDL. */
const envelope = (document: Published, name: string): string =>
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<s:Envelope xmlns:s="${SOAP_ENVELOPE}"><s:Body>` +
  `<StoreDocument xmlns="${STORE_NAMESPACE}">` +
  `<Name>${xmlEscape(name)}</Name>` +
  `<Title>${xmlEscape(document.Title)}</Title>` +
  `<ContentType>${xmlEscape(document.ContentType)}</ContentType>` +
  `<Content>${Buffer.from(document.Content).toString("base64")}</Content>` +
  `</StoreDocument></s:Body></s:Envelope>`;

const entities: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

const unescapeXml = (text: string): string =>
  text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, entity: string) =>
    entity.startsWith("#x")
      ? String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
      : entity.startsWith("#")
        ? String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
        : (entities[entity] ?? whole),
  );

/** The text of the first element with this local name, in any prefix. */
const element = (xml: string, local: string): string | undefined => {
  const match = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${local}(?:\\s[^>]*)?>([^<]*)</(?:[A-Za-z_][\\w.-]*:)?${local}>`,
  ).exec(xml);
  return match === null ? undefined : unescapeXml(match[1]!);
};

/** Read the store's reply as its XML declaration says; the store writes ISO-8859-1. */
const replyText = (bytes: Uint8Array): string => {
  const head = Buffer.from(bytes.subarray(0, 120)).toString("latin1");
  const declared = /encoding="([^"]+)"/.exec(head)?.[1]?.toLowerCase();
  return Buffer.from(bytes).toString(
    declared === "utf-8" || declared === "utf8" ? "utf8" : "latin1",
  );
};

interface StoreAnswer {
  readonly status: number;
  readonly body: Uint8Array;
}

/** The outbound call, aborted through the request's signal when the client disconnects. */
const callStore = (
  origin: string,
  body: string,
  signal: AbortSignal,
): Promise<StoreAnswer> =>
  new Promise((resolve, reject) => {
    const payload = Buffer.from(body, "utf8");
    const outbound = httpRequest(
      `${origin}/soap`,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: `"${STORE_NAMESPACE}#StoreDocument"`,
          "Content-Length": String(payload.length),
        },
        signal,
      },
      (response) => {
        const chunks: Array<Buffer> = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: new Uint8Array(Buffer.concat(chunks)),
          }),
        );
        response.on("error", reject);
      },
    );
    outbound.on("error", reject);
    outbound.end(payload);
  });

const publish =
  (options: Options) =>
  async (request: Received, context: Context): Promise<Reply> => {
    const type = (first(request, "content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase();
    if (type !== "application/json")
      return requestError(
        415,
        `Cannot process the message because the content type '${first(request, "content-type") ?? ""}' was not the expected type 'application/json; charset=utf-8'.`,
      );
    const document = deserialize(request);
    if (typeof document === "string") return requestError(400, document);
    const name = `portal.${document.Name}`;
    let answer: StoreAnswer;
    try {
      answer = await callStore(
        options.soapOrigin,
        envelope(document, name),
        context.signal,
      );
    } catch (cause) {
      return jsonError(
        "System.ServiceModel.EndpointNotFoundException",
        `There was no endpoint listening at ${options.soapOrigin}/soap that could accept the message. ${String(cause)}`,
      );
    }
    const xml = replyText(answer.body);
    const code = element(xml, "FaultCode");
    if (answer.status !== 200 || code === undefined || !/^-?\d+$/.test(code))
      return jsonError(
        "System.ServiceModel.ProtocolException",
        `The content type of the response message does not match the binding (HTTP ${answer.status}).`,
      );
    if (code !== "0")
      return jsonError(
        "DocVault.Portal.StoreFaultException",
        `DocVault ${code}: ${element(xml, "FaultString") ?? ""}`,
      );
    return {
      status: 200,
      lines: [["Content-Type", "application/json; charset=utf-8"]],
      body: JSON.stringify({
        d: {
          __type: "PublishResult:#DocVault.Portal",
          DocumentId: element(xml, "DocumentId") ?? null,
          ETag: element(xml, "ETag") ?? null,
          Name: name,
        },
      }),
    };
  };

export const handler = (given?: Options): Handler => {
  if (given === undefined || typeof given.soapOrigin !== "string")
    throw new Error("soap-proxy: the test must pass { soapOrigin }");
  const options: Options = { soapOrigin: given.soapOrigin.replace(/\/$/, "") };
  return router([{ method: "POST", path: PUBLISH, handle: publish(options) }]);
};
