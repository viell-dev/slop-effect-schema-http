import type { Route } from "../../harness/route.js";
import {
  header,
  headerValues,
  type Received,
  type Reply,
} from "../../harness/server.js";
import { type Document, type Store, validName } from "./store.js";
import { mediaType, plain } from "./wire.js";
import * as Xml from "./xml.js";

/**
 * The WebDAV view, added in 2009 so desktop clients could mount the store. It lives under
 * `/dav/documents/`; `archive/` and the other configured subcollections belong to the nightly
 * archive job. Its quirks:
 *
 * - **Finite depth only.** PROPFIND without `Depth`, which RFC 4918 treats as infinity, is refused
 *   with 403 and `propfind-finite-depth`: an infinite walk once took the server down.
 * - **Multistatus lists collections.** A depth-1 listing includes the collection itself and its
 *   subcollections next to the documents, with a 404 propstat for the properties collections lack.
 *   The content type is `text/xml; charset="utf-8"`, quoted charset and all, as mod_dav wrote it.
 * - **Validators are mandatory (2016).** After two archive robots overwrote each other's
 *   corrections, writes without `If-Match` (replace) or `If-None-Match: *` (create) get 428.
 *   A stale or weak `If-Match` gets 412; `If-Match` compares strongly.
 * - **A MIME allowlist.** PUT bodies outside the allowlist get 415, as does a PROPFIND body that is
 *   not XML.
 * - **Fixed layout.** MKCOL on an existing resource gets 405 with `Allow`; elsewhere 403. Methods
 *   a resource does not support get 405 with its `Allow` list.
 */

const ROOT = "/dav/documents/";
const DAV_XML = 'text/xml; charset="utf-8"';
const accepted = new Set([
  "application/pdf",
  "application/octet-stream",
  "application/xml",
  "text/plain",
  "text/xml",
]);

type Resource =
  | { readonly kind: "collection"; readonly name: string }
  | { readonly kind: "document"; readonly document: Document }
  | { readonly kind: "unmapped"; readonly name: string };

const allow = (resource: Resource): string =>
  resource.kind === "collection"
    ? "OPTIONS, PROPFIND"
    : resource.kind === "document"
      ? "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND"
      : "OPTIONS, PUT";

const resolve = (store: Store, rest: string): Resource | undefined => {
  if (rest === "") return { kind: "collection", name: "" };
  if (rest.endsWith("/") && store.collections.includes(rest.slice(0, -1)))
    return { kind: "collection", name: rest.slice(0, -1) };
  let name: string;
  try {
    name = decodeURIComponent(rest);
  } catch {
    return undefined;
  }
  const document = store.byName(name);
  return document === undefined
    ? { kind: "unmapped", name }
    : { kind: "document", document };
};

const href = (resource: Resource): string =>
  resource.kind === "collection"
    ? `${ROOT}${resource.name === "" ? "" : `${resource.name}/`}`
    : `${ROOT}${encodeURIComponent(resource.kind === "document" ? resource.document.name : resource.name)}`;

/** Entity tags of a conditional header: `*`, a list, or absent. Repeated lines are one list. */
const condition = (
  request: Received,
  name: string,
): "*" | ReadonlyArray<string> | undefined => {
  const values = headerValues(request.lines, name);
  if (values.length === 0) return undefined;
  const joined = values.join(",").trim();
  if (joined === "*") return "*";
  return joined
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
};

const strong = (tags: "*" | ReadonlyArray<string>, etag: string): boolean =>
  tags === "*" || tags.includes(etag);

const weak = (tags: "*" | ReadonlyArray<string>, etag: string): boolean =>
  tags === "*" || tags.some((tag) => tag.replace(/^W\//, "") === etag);

const propstat = (
  props: ReadonlyArray<string>,
  status: string,
): ReadonlyArray<string> =>
  props.length === 0
    ? []
    : [
        Xml.tag(
          "D:propstat",
          {},
          Xml.tag("D:prop", {}, ...props),
          Xml.leaf("D:status", status),
        ),
      ];

const describe = (resource: Resource, started: Date): string => {
  const found =
    resource.kind === "document"
      ? [
          Xml.tag("D:resourcetype"),
          Xml.leaf("D:displayname", resource.document.name),
          Xml.leaf(
            "D:getcontentlength",
            String(resource.document.content.length),
          ),
          Xml.leaf("D:getcontenttype", resource.document.contentType),
          Xml.leaf("D:getetag", resource.document.etag),
          Xml.leaf(
            "D:getlastmodified",
            resource.document.modified.toUTCString(),
          ),
        ]
      : [
          Xml.tag("D:resourcetype", {}, Xml.tag("D:collection")),
          Xml.leaf(
            "D:displayname",
            resource.kind === "collection" && resource.name !== ""
              ? resource.name
              : "documents",
          ),
          Xml.leaf("D:getlastmodified", started.toUTCString()),
        ];
  const missing =
    resource.kind === "document"
      ? []
      : [
          Xml.tag("D:getcontentlength"),
          Xml.tag("D:getcontenttype"),
          Xml.tag("D:getetag"),
        ];
  return Xml.tag(
    "D:response",
    {},
    Xml.leaf("D:href", href(resource)),
    ...propstat(found, "HTTP/1.1 200 OK"),
    ...propstat(missing, "HTTP/1.1 404 Not Found"),
  );
};

const propfind = (
  store: Store,
  started: Date,
  request: Received,
  resource: Resource,
): Reply => {
  const depth = header(request.lines, "depth")?.trim().toLowerCase();
  if (depth === undefined || depth === "infinity")
    return {
      status: 403,
      lines: [["Content-Type", DAV_XML]],
      body: `<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>\n`,
    };
  if (depth !== "0" && depth !== "1")
    return plain(400, "Depth must be 0, 1 or infinity");
  if (request.body.length > 0) {
    const type = mediaType(header(request.lines, "content-type"));
    if (type.type !== "application/xml" && type.type !== "text/xml")
      return plain(
        415,
        `Unsupported Media Type ${type.type || "(none)"}: a PROPFIND body is XML`,
      );
    const source = Xml.decode(
      request.body,
      type.parameters.get("charset") ?? Xml.declared(request.body) ?? "utf-8",
    );
    try {
      const root = Xml.parse(source ?? "");
      if (Xml.local(root) !== "propfind" || Xml.namespace(root) !== "DAV:")
        return plain(400, "Expected a DAV: propfind element");
    } catch {
      return plain(400, "Malformed PROPFIND body");
    }
  }
  if (resource.kind === "unmapped") return plain(404, "Not Found");
  const members: Array<Resource> =
    depth === "1" && resource.kind === "collection" && resource.name === ""
      ? [
          ...store.collections.map((name): Resource => ({
            kind: "collection",
            name,
          })),
          ...store
            .all()
            .map((document): Resource => ({ kind: "document", document })),
        ].toSorted((a, b) => (href(a) < href(b) ? -1 : 1))
      : [];
  return {
    status: 207,
    statusText: "Multi-Status",
    lines: [["Content-Type", DAV_XML]],
    body: `<?xml version="1.0" encoding="utf-8"?>\n${Xml.tag(
      "D:multistatus",
      { "xmlns:D": "DAV:" },
      ...[resource, ...members].map((member) => describe(member, started)),
    )}\n`,
  };
};

const put = (store: Store, request: Received, resource: Resource): Reply => {
  if (resource.kind === "collection")
    return plain(405, "Method Not Allowed", [["Allow", allow(resource)]]);
  if (resource.kind === "unmapped" && resource.name.includes("/"))
    return plain(403, "Subcollections are maintained by the archive job");
  if (resource.kind === "unmapped" && !validName(resource.name))
    return plain(403, `Invalid document name ${resource.name}`);
  const type = mediaType(header(request.lines, "content-type")).type;
  if (!accepted.has(type))
    return plain(
      415,
      `Unsupported Media Type ${type || "(none)"}: the store accepts ${[...accepted].join(", ")}`,
    );
  const ifMatch = condition(request, "if-match");
  const ifNoneMatch = condition(request, "if-none-match");
  if (ifMatch === undefined && ifNoneMatch === undefined)
    return plain(
      428,
      "Precondition Required: send If-Match with the current ETag to replace, or If-None-Match: * to create",
    );
  if (resource.kind === "document") {
    const { document } = resource;
    if (
      (ifMatch !== undefined && !strong(ifMatch, document.etag)) ||
      (ifNoneMatch !== undefined && weak(ifNoneMatch, document.etag))
    )
      return plain(412, "Precondition Failed");
    store.replace(document, request.body, type);
    return { status: 204, lines: [["ETag", document.etag]] };
  }
  if (ifMatch !== undefined) return plain(412, "Precondition Failed");
  const document = store.create({
    name: resource.name,
    title: resource.name,
    contentType: type,
    content: request.body,
  });
  return {
    status: 201,
    lines: [
      ["ETag", document.etag],
      ["Location", href({ kind: "document", document })],
      ["Content-Length", "0"],
    ],
  };
};

const remove = (store: Store, request: Received, resource: Resource): Reply => {
  if (resource.kind === "collection")
    return plain(405, "Method Not Allowed", [["Allow", allow(resource)]]);
  if (resource.kind === "unmapped") return plain(404, "Not Found");
  const ifMatch = condition(request, "if-match");
  if (ifMatch === undefined)
    return plain(
      428,
      "Precondition Required: send If-Match with the current ETag to delete",
    );
  if (!strong(ifMatch, resource.document.etag))
    return plain(412, "Precondition Failed");
  store.remove(resource.document);
  return { status: 204 };
};

const read = (request: Received, resource: Resource): Reply => {
  if (resource.kind === "unmapped") return plain(404, "Not Found");
  if (resource.kind === "collection")
    return plain(405, "Method Not Allowed", [["Allow", allow(resource)]]);
  const { document } = resource;
  const validators: Array<readonly [string, string]> = [
    ["ETag", document.etag],
    ["Last-Modified", document.modified.toUTCString()],
  ];
  const ifNoneMatch = condition(request, "if-none-match");
  if (ifNoneMatch !== undefined && weak(ifNoneMatch, document.etag))
    return { status: 304, lines: validators };
  return {
    status: 200,
    lines: [["Content-Type", document.contentType], ...validators],
    ...(request.method === "HEAD" ? {} : { body: document.content }),
  };
};

/** The WebDAV routes. `started` dates the collections. */
export const routes = (store: Store, started: Date): ReadonlyArray<Route> => [
  {
    method: "*",
    path: /^\/dav\/documents\/(?<rest>.*)$/,
    handle: (request, context) => {
      const resource = resolve(store, context.params["rest"] ?? "");
      if (resource === undefined) return plain(400, "Malformed path");
      switch (request.method) {
        case "PROPFIND":
          return propfind(store, started, request, resource);
        case "GET":
        case "HEAD":
          return read(request, resource);
        case "PUT":
          return put(store, request, resource);
        case "DELETE":
          return remove(store, request, resource);
        case "MKCOL":
          return resource.kind === "unmapped"
            ? plain(403, "Collections are maintained by the archive job")
            : plain(405, "Method Not Allowed", [["Allow", allow(resource)]]);
        case "OPTIONS":
          return {
            status: 200,
            lines: [
              ["DAV", "1"],
              ["Allow", allow(resource)],
              ["Content-Length", "0"],
            ],
          };
        default:
          return plain(405, "Method Not Allowed", [["Allow", allow(resource)]]);
      }
    },
  },
];
