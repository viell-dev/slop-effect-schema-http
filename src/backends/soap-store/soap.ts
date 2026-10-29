import type { Route } from "../../harness/route.js";
import {
  type Context,
  header,
  headerValues,
  type Received,
  type Reply,
} from "../../harness/server.js";
import { dateTime, type Document, type Store, validName } from "./store.js";
import { mediaType, plain, rawQuery } from "./wire.js";
import { schemaPart, serviceDescription } from "./wsdl.js";
import * as Xml from "./xml.js";

/**
 * The SOAP side of DocVault, a document store first written in 2003 for an in-house platform and
 * ported to a servlet container in 2009. Its quirks, oldest first:
 *
 * - **Fault codes inside 200 (2003).** The original platform had no SOAP fault support, so its
 *   authors copied the fault vocabulary into every result: `<FaultCode>` and `<FaultString>`,
 *   where `0` means success. Every action answers HTTP 200, whatever happened. Three generations
 *   of clients branch on `FaultCode`, so it stays.
 * - **Latin-1 under charset-less `text/xml` (2003).** The platform wrote ISO-8859-1 and said so
 *   only in the XML declaration; characters above U+00FF become numeric character references.
 *   The port kept the writer byte for byte to avoid re-certifying the archive interface.
 * - **One list, three shapes (2005).** Results hold `<Count>` and, for one or more items,
 *   `<Documents>`. An empty list omits `<Documents>`. A single item is wrapped in `<Item>`, added
 *   in 2005 so a Perl reporting client stopped collapsing one-element lists into scalars. Many
 *   items are listed directly. The Perl client still runs.
 * - **The front controller (2009).** The port put a servlet in front of the SOAP stack. It
 *   enforces WS-I Basic Profile R2744: SOAP 1.1 requests need exactly one `SOAPAction` header,
 *   quoted, naming the body element as `<namespace>#<element>`. The body element must be in the
 *   service's namespace, whatever prefix binds it, before anything dispatches on its local name. It
 *   answers framing errors with plain-text 400 and unknown media types with 415, because it
 *   predates the stack's fault writer.
 * - **SOAP 1.2 on the same URL (2009).** `application/soap+xml` selects SOAP 1.2, whose action
 *   travels as the `action` parameter of the content type; a `SOAPAction` header is ignored there.
 *   1.2 replies are UTF-8 and say so.
 * - **The one correct action (2011).** `LockDocument` was written by a contractor who read the
 *   SOAP 1.1 specification: it reports errors as real SOAP faults with HTTP 500 and has no
 *   `FaultCode`. Its fault writer answers 500 for SOAP 1.2 too, where the 1.2 binding would send
 *   400 for sender faults. Nobody else adopted it.
 * - **Downloads by GET with a body (2003).** The download servlet reads a `DownloadDocument`
 *   envelope from the body of a GET and answers the bytes. Its `doPost` was never written, so POST
 *   gets 405. The vendor manual still documents it, and the archive robot depends on it.
 */

export const NAMESPACE = "urn:docvault:store:2003";

const envelopes = {
  "1.1": "http://schemas.xmlsoap.org/soap/envelope/",
  "1.2": "http://www.w3.org/2003/05/soap-envelope",
} as const;

type Version = keyof typeof envelopes;

interface Call {
  readonly version: Version;
  readonly action: string;
  readonly payload: Xml.Node;
}

/** The JSON switches the tests and the cross-service flows configure; see `index.ts`. */
export interface Hooks {
  readonly failStore?:
    | {
        readonly names?: ReadonlyArray<string> | undefined;
        readonly calls?: ReadonlyArray<number> | undefined;
      }
    | undefined;
  readonly latency?: Readonly<Record<string, number>> | undefined;
  readonly hold?: ReadonlyArray<string> | undefined;
}

/** Apply the configured latency or hold for an action, ending early when the client disconnects. */
const pause = (
  hooks: Hooks,
  action: string,
  signal: AbortSignal,
): Promise<void> => {
  const held = hooks.hold?.includes(action) === true;
  const delay = hooks.latency?.[action];
  if (!held && delay === undefined) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = held ? undefined : setTimeout(resolve, delay);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
};

/** Validate the transport framing the way the 2009 front controller does. */
const frame = (request: Received): Call | Reply => {
  const contentType = mediaType(header(request.lines, "content-type"));
  let version: Version;
  let action: string;
  if (contentType.type === "text/xml") {
    version = "1.1";
    const values = headerValues(request.lines, "soapaction");
    if (values.length === 0)
      return plain(
        400,
        "SOAPAction header is required (WS-I Basic Profile R2744)",
      );
    if (values.length > 1)
      return plain(400, "SOAPAction header must appear exactly once");
    const quoted = /^"([^"]*)"$/.exec(values[0]!.trim());
    if (quoted === null)
      return plain(
        400,
        `SOAPAction must be a quoted string (WS-I Basic Profile R2744), got ${values[0]}`,
      );
    action = quoted[1]!;
  } else if (contentType.type === "application/soap+xml") {
    version = "1.2";
    const parameter = contentType.parameters.get("action");
    if (parameter === undefined)
      return plain(
        400,
        "SOAP 1.2 requests carry their action in the Content-Type action parameter",
      );
    action = parameter;
  } else
    return plain(
      415,
      `Unsupported Media Type ${contentType.type || "(none)"}: SOAP 1.1 uses text/xml, SOAP 1.2 application/soap+xml`,
    );
  const label =
    contentType.parameters.get("charset") ??
    Xml.declared(request.body) ??
    "utf-8";
  const source = Xml.decode(request.body, label);
  if (source === undefined)
    return plain(400, `The request body is not valid ${label}`);
  let envelope: Xml.Node;
  try {
    envelope = Xml.parse(source);
  } catch (cause) {
    return plain(400, `Malformed XML: ${(cause as Error).message}`);
  }
  if (
    Xml.local(envelope) !== "Envelope" ||
    Xml.namespace(envelope) !== envelopes[version]
  )
    return plain(
      400,
      `Expected a SOAP ${version} Envelope in ${envelopes[version]}`,
    );
  const body = Xml.elements(envelope).find(
    (part) =>
      Xml.local(part) === "Body" && Xml.namespace(part) === envelopes[version],
  );
  const payloads = body === undefined ? [] : Xml.elements(body);
  if (payloads.length !== 1)
    return plain(400, "The SOAP Body must hold exactly one element");
  const payload = payloads[0]!;
  const namespace = Xml.namespace(payload);
  if (namespace !== NAMESPACE)
    return plain(
      400,
      `The body element {${namespace ?? ""}}${Xml.local(payload)} is not an operation of ${NAMESPACE}`,
    );
  const element = `${namespace}#${Xml.local(payload)}`;
  if (action !== element)
    return plain(
      400,
      `SOAPAction ${action} does not match the body element ${element}`,
    );
  return { version, action: Xml.local(payload), payload };
};

type Outcome =
  | { readonly kind: "result"; readonly payload: string }
  | {
      readonly kind: "fault";
      readonly sender: boolean;
      readonly message: string;
      readonly detail: string;
    };

const prefixes = { "1.1": "soap", "1.2": "env" } as const;

const render = (version: Version, status: number, content: string): Reply => {
  const prefix = prefixes[version];
  const document = Xml.tag(
    `${prefix}:Envelope`,
    { [`xmlns:${prefix}`]: envelopes[version] },
    Xml.tag(`${prefix}:Body`, {}, content),
  );
  return version === "1.1"
    ? {
        status,
        lines: [["Content-Type", "text/xml"]],
        body: Xml.latin1(
          `<?xml version="1.0" encoding="ISO-8859-1"?>\r\n${document}`,
        ),
      }
    : {
        status,
        lines: [["Content-Type", "application/soap+xml; charset=utf-8"]],
        body: `<?xml version="1.0" encoding="utf-8"?>\r\n${document}`,
      };
};

const respond = (version: Version, outcome: Outcome): Reply => {
  if (outcome.kind === "result") return render(version, 200, outcome.payload);
  const fault =
    version === "1.1"
      ? Xml.tag(
          "soap:Fault",
          {},
          Xml.leaf("faultcode", outcome.sender ? "soap:Client" : "soap:Server"),
          Xml.leaf("faultstring", outcome.message),
          Xml.tag("detail", {}, outcome.detail),
        )
      : Xml.tag(
          "env:Fault",
          {},
          Xml.tag(
            "env:Code",
            {},
            Xml.leaf(
              "env:Value",
              outcome.sender ? "env:Sender" : "env:Receiver",
            ),
          ),
          Xml.tag(
            "env:Reason",
            {},
            `<env:Text xml:lang="en">${Xml.escape(outcome.message)}</env:Text>`,
          ),
          Xml.tag("env:Detail", {}, outcome.detail),
        );
  return render(version, 500, fault);
};

const sender = (message: string): Outcome => ({
  kind: "fault",
  sender: true,
  message,
  detail: "",
});

/** A 2003-style result: `FaultCode` and `FaultString` first, then the action's fields. */
const result = (
  action: string,
  code: number,
  message: string,
  ...fields: ReadonlyArray<string>
): Outcome => ({
  kind: "result",
  payload: Xml.tag(
    `${action}Response`,
    { xmlns: NAMESPACE },
    Xml.tag(
      `${action}Result`,
      {},
      Xml.leaf("FaultCode", String(code)),
      Xml.leaf("FaultString", message),
      ...fields,
    ),
  ),
});

const field = (payload: Xml.Node, name: string): string | undefined => {
  const node = Xml.find(payload, name);
  return node === undefined ? undefined : Xml.text(node);
};

const base64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const info = (document: Document): ReadonlyArray<string> => [
  Xml.leaf("Id", document.id),
  Xml.leaf("Name", document.name),
  Xml.leaf("Title", document.title),
  Xml.leaf("ContentType", document.contentType),
  Xml.leaf("Size", String(document.content.length)),
  Xml.leaf("ETag", document.etag),
  Xml.leaf("Modified", dateTime(document.modified)),
];

const actions = (
  store: Store,
  hooks: Hooks,
): Readonly<Record<string, (payload: Xml.Node) => Outcome>> => {
  let storeCalls = 0;
  return {
    StoreDocument: (payload) => {
      const name = field(payload, "Name");
      const title = field(payload, "Title") ?? "";
      const contentType = field(payload, "ContentType");
      const content = field(payload, "Content");
      if (
        name === undefined ||
        contentType === undefined ||
        content === undefined
      )
        return result(
          "StoreDocument",
          2000,
          "Malformed request: Name, ContentType and Content are required",
        );
      if (!validName(name))
        return result("StoreDocument", 2001, `Invalid document name: ${name}`);
      if (!base64.test(content))
        return result("StoreDocument", 2002, "Content is not valid base64");
      storeCalls++;
      if (
        hooks.failStore?.names?.includes(name) === true ||
        hooks.failStore?.calls?.includes(storeCalls) === true
      )
        return result(
          "StoreDocument",
          5003,
          "Storage backend unavailable; the document was not stored",
        );
      if (store.byName(name) !== undefined)
        return result(
          "StoreDocument",
          1002,
          `A document named ${name} already exists`,
        );
      const document = store.create({
        name,
        title,
        contentType,
        content: new Uint8Array(Buffer.from(content, "base64")),
      });
      return result(
        "StoreDocument",
        0,
        "OK",
        Xml.leaf("DocumentId", document.id),
        Xml.leaf("ETag", document.etag),
      );
    },
    FetchDocument: (payload) => {
      const id = field(payload, "Id");
      if (id === undefined)
        return result(
          "FetchDocument",
          2000,
          "Malformed request: Id is required",
        );
      const document = store.byId(id);
      if (document === undefined)
        return result("FetchDocument", 1001, `No document with id ${id}`);
      return result(
        "FetchDocument",
        0,
        "OK",
        Xml.tag(
          "Document",
          {},
          ...info(document),
          Xml.leaf("Content", Buffer.from(document.content).toString("base64")),
        ),
      );
    },
    ListDocuments: (payload) => {
      const prefix = field(payload, "Prefix");
      if (prefix === undefined)
        return result(
          "ListDocuments",
          2000,
          "Malformed request: Prefix is required",
        );
      const found = store
        .all()
        .filter((document) => document.name.startsWith(prefix));
      const items = found.map((document) =>
        Xml.tag("DocumentInfo", {}, ...info(document)),
      );
      return result(
        "ListDocuments",
        0,
        "OK",
        Xml.leaf("Count", String(found.length)),
        ...(items.length === 0
          ? []
          : items.length === 1
            ? [Xml.tag("Documents", {}, Xml.tag("Item", {}, items[0]!))]
            : [Xml.tag("Documents", {}, ...items)]),
      );
    },
    LockDocument: (payload) => {
      const id = field(payload, "Id");
      const owner = field(payload, "Owner");
      const seconds = field(payload, "Seconds") ?? "300";
      if (id === undefined || owner === undefined || owner.trim() === "")
        return sender("Id and Owner are required");
      if (!/^\d{1,4}$/.test(seconds) || +seconds < 1 || +seconds > 3600)
        return sender("Seconds must be an integer from 1 to 3600");
      if (store.byId(id) === undefined)
        return {
          kind: "fault",
          sender: true,
          message: `No document with id ${id}`,
          detail: Xml.tag(
            "DocumentNotFound",
            { xmlns: NAMESPACE },
            Xml.leaf("Id", id),
          ),
        };
      const held = store.lock(id);
      if (held !== undefined && held.owner !== owner)
        return {
          kind: "fault",
          sender: false,
          message: `Document ${id} is locked by ${held.owner}`,
          detail: Xml.tag(
            "LockConflict",
            { xmlns: NAMESPACE },
            Xml.leaf("HeldBy", held.owner),
            Xml.leaf("Expires", dateTime(held.expires)),
          ),
        };
      const lock = store.acquire(id, owner, +seconds);
      return {
        kind: "result",
        payload: Xml.tag(
          "LockDocumentResponse",
          { xmlns: NAMESPACE },
          Xml.tag(
            "LockDocumentResult",
            {},
            Xml.leaf("LockToken", lock.token),
            Xml.leaf("Owner", lock.owner),
            Xml.leaf("Expires", dateTime(lock.expires)),
          ),
        ),
      };
    },
  };
};

const metadata = (request: Received, context: Context): Reply => {
  let query: ReturnType<typeof rawQuery>;
  try {
    query = rawQuery(request.target);
  } catch {
    return plain(400, "Malformed query string");
  }
  // The metadata handler copies the WCF convention: a bare `wsdl` key asks for the description and
  // `wsdl=<name>` for one of its parts, so an empty value names a part called "".
  const entry = query.find(([key]) => key.toLowerCase() === "wsdl");
  if (entry === undefined)
    return plain(404, "Append ?wsdl for the service description");
  const [, part] = entry;
  if (part === null)
    return {
      status: 200,
      lines: [["Content-Type", "text/xml; charset=utf-8"]],
      body: serviceDescription(context.origin),
    };
  if (part === "types")
    return {
      status: 200,
      lines: [["Content-Type", "text/xml; charset=utf-8"]],
      body: schemaPart(),
    };
  return plain(404, `No WSDL part named '${part}'`);
};

/** The routes of the SOAP endpoint, its metadata and the download servlet. */
export const routes = (store: Store, hooks: Hooks): ReadonlyArray<Route> => {
  const table = actions(store, hooks);
  return [
    {
      method: "POST",
      path: "/soap",
      handle: async (request, context) => {
        const call = frame(request);
        if (!("payload" in call)) return call;
        const action = table[call.action];
        if (action === undefined)
          return plain(
            400,
            call.action === "DownloadDocument"
              ? "DownloadDocument is served by GET /soap/download"
              : `Unknown action ${call.action}`,
          );
        await pause(hooks, call.action, context.signal);
        return respond(call.version, action(call.payload));
      },
    },
    { method: "GET", path: "/soap", handle: metadata },
    {
      method: "GET",
      path: "/soap/download",
      handle: async (request, context) => {
        if (request.body.length === 0)
          return plain(
            400,
            "The download servlet reads a DownloadDocument envelope from the request body",
          );
        const call = frame(request);
        if (!("payload" in call)) return call;
        if (call.version !== "1.1" || call.action !== "DownloadDocument")
          return plain(
            400,
            "The download servlet only serves DownloadDocument",
          );
        await pause(hooks, call.action, context.signal);
        const id = field(call.payload, "Id");
        const document = id === undefined ? undefined : store.byId(id);
        if (document === undefined)
          return plain(404, `No document with id ${id ?? "(none)"}`);
        return {
          status: 200,
          lines: [
            ["Content-Type", document.contentType],
            [
              "Content-Disposition",
              `attachment; filename*=UTF-8''${encodeURIComponent(document.name)}`,
            ],
            ["ETag", document.etag],
          ],
          body: document.content,
        };
      },
    },
  ];
};
