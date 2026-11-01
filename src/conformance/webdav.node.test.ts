/**
 * STAT-7/PAY-3a/RET-3: DocVault's WebDAV view against stock httpd 2.4.69 mod_dav/mod_dav_fs.
 * Node-only: read byte-for-byte recordings and send raw HTTP over real loopback sockets. These
 * backend-side readers share no consumer parser, schema or backend implementation.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import {
  data,
  date,
  differences,
  header,
  infoset,
  masked,
  parseXml,
  recorded as readRecorded,
  replaceHeader,
  requestHeader,
  send,
  type Infoset,
  type Response,
  type XmlElement,
} from "./recordings.js";

/** Copied from the recording's synthetic dataset, not from backend defaults. */
const options = data("httpd-dav", "data.json") as {
  documents: Array<{
    name: string;
    title: string;
    contentType: string;
    text: string;
    modified: string;
  }>;
  collections: Array<string>;
  clock: string;
};

const ROOT = "/dav/documents/";
const CAFE = "Café & notes.txt";
const MODIFIED = "Wed, 31 Jan 2024 12:00:00 GMT";
const XML = 'text/xml; charset="utf-8"';
const OK = "HTTP/1.1 200 OK";
const MISSING = "HTTP/1.1 404 Not Found";
const FS = "http://apache.org/dav/props/";
const UNKNOWN = "{urn:recording:missing}missing";
// Opaque document-version tags, observed over GET on this fixed dataset. They are deliberately
// different from Apache's filesystem tags, not per-run values and never masked.
const TAGS: Readonly<Record<string, string>> = {
  "report.txt": '"777fcd04ea83f19f"',
  [CAFE]: '"e9a58ea1f0439b34"',
};
const APACHE_TAGS: Readonly<Record<string, string>> = {
  "report.txt": '"11-6103c9e4a1000"',
  [CAFE]: '"6-6103c9e4a1000"',
};
const strongTag = /^"[\x21\x23-\x7e\x80-\xff]*"$/;
const dav = (name: string) => `{DAV:}${name}`;
const element = (name: string, content: Infoset["content"] = ""): Infoset => ({
  name,
  attributes: {},
  content,
});
const prop = (name: string, content: Infoset["content"] = "") =>
  element(dav(name), content);

const elements = (node: Infoset): ReadonlyArray<Infoset> => {
  if (typeof node.content !== "string") return node.content;
  expect(node.content).toBe("");
  return [];
};
const text = (node: Infoset): string => {
  expect(typeof node.content).toBe("string");
  return node.content as string;
};
const is = (node: Infoset, name: string) => {
  expect(node.name).toBe(dav(name));
  expect(node.attributes).toEqual({});
};
interface Group {
  readonly status: string;
  readonly properties: ReadonlyArray<Infoset>;
}
interface Row {
  readonly href: string;
  readonly groups: ReadonlyArray<Group>;
}

/** The infoset reader discards inter-element text; DAV permits only whitespace there. */
const checkMixedText = (node: XmlElement): void => {
  const nested = node.children.filter(
    (child): child is XmlElement => "name" in child,
  );
  if (nested.length > 0)
    for (const child of node.children)
      if ("text" in child) expect(child.text.trim()).toBe("");
  for (const child of nested) checkMixedText(child);
};

/** Keep every property, its expanded namespace, value/children, status and wire order. */
const multistatus = (body: Buffer): ReadonlyArray<Row> => {
  checkMixedText(parseXml(body.toString("utf8")));
  const root = infoset(body, () => false);
  is(root, "multistatus");
  const rows = elements(root).map((response): Row => {
    is(response, "response");
    const [href, ...groups] = elements(response);
    is(href!, "href");
    return {
      href: text(href!),
      groups: groups.map((group) => {
        is(group, "propstat");
        const children = elements(group);
        expect(children).toHaveLength(2);
        const [properties, status] = children;
        is(properties!, "prop");
        is(status!, "status");
        return { status: text(status!), properties: elements(properties!) };
      }),
    };
  });
  expect(new Set(rows.map((row) => decodeURIComponent(row.href))).size).toBe(
    rows.length,
  );
  return rows;
};

const identity = (row: Row) => decodeURIComponent(row.href);
const writtenNames = (node: XmlElement): ReadonlyArray<string> => [
  node.name,
  ...node.children.flatMap((child) =>
    "name" in child ? writtenNames(child) : [],
  ),
];
const nameOf = (row: Row) =>
  identity(row).slice(ROOT.length).replace(/\/$/, "");
const collection = (row: Row) => row.href.endsWith("/");

/** A duplicate property, an added status group or any changed value must remain visible. */
const properties = (row: Row) => {
  const map = new Map<string, { status: string; value: Infoset }>();
  expect(new Set(row.groups.map((group) => group.status)).size).toBe(
    row.groups.length,
  );
  for (const group of row.groups)
    for (const value of group.properties) {
      expect(map.has(value.name)).toBe(false);
      map.set(value.name, { status: group.status, value });
    }
  return map;
};
const propertyDifferences = (
  apache: Row,
  docVault: Row,
): ReadonlyArray<string> => {
  expect(identity(docVault)).toBe(identity(apache));
  const left = properties(apache);
  const right = properties(docVault);
  return [...new Set([...left.keys(), ...right.keys()])]
    .toSorted()
    .flatMap((key) => {
      const a = left.get(key);
      const b = right.get(key);
      if (a === undefined) return [`${key}: DocVault only (${b!.status})`];
      if (b === undefined) return [`${key}: Apache only (${a.status})`];
      const found: Array<string> = [];
      if (a.status !== b.status)
        found.push(`${key}: ${a.status} -> ${b.status}`);
      if (JSON.stringify(a.value) !== JSON.stringify(b.value))
        found.push(`${key}: value`);
      return found;
    });
};

const locks = prop(
  "supportedlock",
  ["exclusive", "shared"].map((scope) =>
    prop("lockentry", [
      prop("lockscope", [prop(scope)]),
      prop("locktype", [prop("write")]),
    ]),
  ),
);

/** Explicit complete models also pin Apache-only properties; none is silently discarded. */
const apacheGroups = (row: Row, allprop: boolean, created: string): Group[] => {
  const directory = collection(row);
  const name = nameOf(row);
  const found = [prop("resourcetype", directory ? [prop("collection")] : "")];
  if (allprop) found.push(prop("creationdate", created));
  if (!directory)
    found.push(prop("getcontentlength", name === CAFE ? "6" : "17"));
  if (!allprop)
    found.push(
      prop("getcontenttype", directory ? "httpd/unix-directory" : "text/plain"),
    );
  if (allprop) found.push(prop("getlastmodified", MODIFIED));
  found.push(
    prop("getetag", directory ? '"1000-6103c9e4a1000"' : APACHE_TAGS[name]!),
  );
  if (!allprop) found.push(prop("getlastmodified", MODIFIED));
  if (allprop) {
    if (!directory) found.push(element(`{${FS}}executable`, "F"));
    found.push(locks, prop("lockdiscovery"));
    found.push(
      prop("getcontenttype", directory ? "httpd/unix-directory" : "text/plain"),
    );
  }
  return [
    { status: OK, properties: found },
    ...(allprop
      ? []
      : [
          {
            status: MISSING,
            properties: [
              prop("displayname"),
              ...(directory ? [prop("getcontentlength")] : []),
              element(UNKNOWN),
            ],
          },
        ]),
  ];
};

const docVaultGroups = (row: Row): Group[] => {
  const directory = collection(row);
  const name = nameOf(row);
  return [
    {
      status: OK,
      properties: [
        prop("resourcetype", directory ? [prop("collection")] : ""),
        prop("displayname", name || "documents"),
        ...(!directory
          ? [
              prop("getcontentlength", name === CAFE ? "6" : "17"),
              prop("getcontenttype", "text/plain"),
              prop("getetag", TAGS[name]!),
            ]
          : []),
        prop("getlastmodified", MODIFIED),
      ],
    },
    ...(directory
      ? [
          {
            status: MISSING,
            properties: [
              prop("getcontentlength"),
              prop("getcontenttype"),
              prop("getetag"),
            ],
          },
        ]
      : []),
  ];
};

const intendedPropertyDifferences = (directory: boolean, allprop: boolean) => {
  const moved = (name: string) => [
    `${dav(name)}: ${OK} -> ${MISSING}`,
    `${dav(name)}: value`,
  ];
  return [
    ...(allprop
      ? [
          `${dav("creationdate")}: Apache only (${OK})`,
          `${dav("displayname")}: DocVault only (${OK})`,
          `${dav("lockdiscovery")}: Apache only (${OK})`,
          `${dav("supportedlock")}: Apache only (${OK})`,
          ...(!directory ? [`{${FS}}executable: Apache only (${OK})`] : []),
        ]
      : [
          `${dav("displayname")}: ${MISSING} -> ${OK}`,
          `${dav("displayname")}: value`,
          `${UNKNOWN}: Apache only (${MISSING})`,
        ]),
    ...(directory
      ? [
          ...(allprop
            ? [`${dav("getcontentlength")}: DocVault only (${MISSING})`]
            : []),
          ...moved("getcontenttype"),
          ...moved("getetag"),
        ]
      : [`${dav("getetag")}: value`]),
  ].toSorted();
};

/** Sole response mask: Date. Every other header and the body participates in differences(). */
const compareWire = (
  expected: Response,
  actual: Response,
  kept: ReadonlyArray<string>,
) => {
  const [left, right] = masked([expected, actual], [date]);
  expect(differences(left, right)).toEqual(kept);
  expect(header(left, "server")).toEqual(["Apache/2.4.69 (Unix)"]);
  expect(header(right, "server")).toEqual([]);
  expect(header(left, "connection")).toEqual(["close"]);
  expect(header(right, "connection")).toEqual(["close"]);
  expect(header(left, "transfer-encoding")).toEqual([]);
  const empty =
    left.status === 304 || header(left, "content-length")[0] === "0";
  expect(header(right, "transfer-encoding")).toEqual(empty ? [] : ["chunked"]);
  expect(header(right, "content-length")).toEqual(
    left.status === 304 || !empty ? [] : ["0"],
  );
  if (header(left, "content-length").length > 0)
    expect(header(left, "content-length")).toEqual([String(left.body.length)]);
};
const PAGE = [
  "header content-length",
  "header content-type",
  "header server",
  "header transfer-encoding",
  "body",
];
const READ = [
  "header accept-ranges",
  "header content-length",
  "header etag",
  "header server",
  "header transfer-encoding",
];
const CONDITIONAL = ["header accept-ranges", "header etag", "header server"];
const exchange = (name: string) => readRecorded("httpd-dav", name);
const dispatch = (origin: string, request: Buffer) =>
  send(origin, request).pipe(Effect.timeout("3 seconds"));

/** Assert exact received method/target/header lines/body bytes/count, including setup requests. */
const ledger = (
  requests: ReadonlyArray<Buffer>,
  received: ReadonlyArray<{
    readonly method: string;
    readonly target: string;
    readonly lines: ReadonlyArray<readonly [string, string]>;
    readonly body: Uint8Array;
  }>,
) => {
  expect(received).toHaveLength(requests.length);
  requests.forEach((request, index) => {
    const end = request.indexOf("\r\n\r\n");
    const [start, ...lines] = request
      .subarray(0, end)
      .toString("latin1")
      .split("\r\n");
    const [method, target] = start!.split(" ");
    expect(received[index]!.method).toBe(method);
    expect(received[index]!.target).toBe(target);
    expect(received[index]!.lines).toEqual(
      lines.map((line) => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon), line.slice(colon + 1).trimStart()];
      }),
    );
    expect(Buffer.from(received[index]!.body)).toEqual(
      request.subarray(end + 4),
    );
  });
};

const validators = (expected: Response, actual: Response) => {
  expect(header(expected, "etag")).toEqual([APACHE_TAGS["report.txt"]]);
  expect(header(actual, "etag")).toEqual([TAGS["report.txt"]]);
  expect(header(expected, "etag")[0]).toMatch(strongTag);
  expect(header(actual, "etag")[0]).toMatch(strongTag);
  expect(header(expected, "last-modified")).toEqual([MODIFIED]);
  expect(header(actual, "last-modified")).toEqual(
    header(expected, "last-modified"),
  );
  expect(header(expected, "accept-ranges")).toEqual(["bytes"]);
  expect(header(actual, "accept-ranges")).toEqual([]);
};

describe("DocVault's WebDAV view against recorded stock mod_dav", () => {
  for (const name of ["allprop-depth1", "props-depth1"])
    it.live(
      `[PAY-3a] ${name}: complete DAV properties and status groups, with fixed-set differences pinned`,
      () =>
        Effect.gen(function* () {
          const recorded = exchange(name);
          const store = yield* lane.backend("soap-store", options);
          const actual = yield* dispatch(store.origin, recorded.request);
          compareWire(recorded.response, actual, [
            "header content-length",
            "header server",
            "header transfer-encoding",
            "body",
          ]);
          expect(actual.status).toBe(207);
          expect(header(actual, "content-type")).toEqual([XML]);
          expect(header(recorded.response, "content-type")).toEqual([XML]);
          expect(header(actual, "transfer-encoding")).toEqual(["chunked"]);
          const apache = multistatus(recorded.response.body);
          const docVault = multistatus(actual.body);
          // Pair decoded resource identities, but pin both exact href spellings and wire order.
          expect(apache.map((row) => row.href)).toEqual([
            ROOT,
            `${ROOT}Caf%c3%a9%20&%20notes.txt`,
            `${ROOT}report.txt`,
            `${ROOT}templates/`,
            `${ROOT}archive/`,
          ]);
          expect(docVault.map((row) => row.href)).toEqual([
            ROOT,
            `${ROOT}Caf%C3%A9%20%26%20notes.txt`,
            `${ROOT}archive/`,
            `${ROOT}report.txt`,
            `${ROOT}templates/`,
          ]);
          const allprop = name === "allprop-depth1";
          // Apache's creationdate has no DocVault equivalent. Preserve it as a real extra property,
          // validate its shape and agreement across this dataset; do not replace/mask its value.
          const created = allprop
            ? text(properties(apache[0]!).get(dav("creationdate"))!.value)
            : "";
          if (allprop)
            expect(created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
          for (const row of apache) {
            expect(row.groups).toEqual(apacheGroups(row, allprop, created));
            const counterpart = docVault.find(
              (other) => identity(other) === identity(row),
            )!;
            expect(counterpart.groups).toEqual(docVaultGroups(row));
            expect(propertyDifferences(row, counterpart).toSorted()).toEqual(
              intendedPropertyDifferences(collection(row), allprop),
            );
            if (!collection(row)) {
              expect(text(properties(row).get(dav("getetag"))!.value)).toMatch(
                strongTag,
              );
              expect(
                text(properties(counterpart).get(dav("getetag"))!.value),
              ).toMatch(strongTag);
            }
          }
          const rawApache = parseXml(recorded.response.body.toString("utf8"));
          const rawDocVault = parseXml(actual.body.toString("utf8"));
          expect(rawApache.name).toBe("D:multistatus");
          expect(rawDocVault.name).toBe("D:multistatus");
          expect(rawApache.attributes).toEqual([
            ["xmlns:D", "DAV:"],
            ...(allprop ? [] : [["xmlns:ns1", "urn:recording:missing"]]),
            ["xmlns:ns0", "DAV:"],
          ]);
          expect(rawDocVault.attributes).toEqual([["xmlns:D", "DAV:"]]);
          for (const node of rawApache.children)
            if ("name" in node)
              expect(node.attributes).toEqual([
                ["xmlns:lp1", "DAV:"],
                ["xmlns:lp2", FS],
                ...(allprop
                  ? []
                  : [
                      ["xmlns:g0", "DAV:"],
                      ["xmlns:g1", "urn:recording:missing"],
                    ]),
              ]);
          for (const node of rawDocVault.children)
            if ("name" in node) expect(node.attributes).toEqual([]);
          expect([...new Set(writtenNames(rawDocVault))].toSorted()).toEqual(
            [
              "collection",
              "displayname",
              "getcontentlength",
              "getcontenttype",
              "getetag",
              "getlastmodified",
              "href",
              "multistatus",
              "prop",
              "propstat",
              "resourcetype",
              "response",
              "status",
            ]
              .map((local) => `D:${local}`)
              .toSorted(),
          );
          expect([...new Set(writtenNames(rawApache))].toSorted()).toEqual(
            [
              ...[
                "collection",
                "getcontenttype",
                "href",
                "multistatus",
                "prop",
                "propstat",
                "response",
                "status",
              ].map((local) => `D:${local}`),
              ...[
                "getcontentlength",
                "getetag",
                "getlastmodified",
                "resourcetype",
              ].map((local) => `lp1:${local}`),
              ...(allprop
                ? [
                    "lp1:creationdate",
                    "lp2:executable",
                    ...[
                      "exclusive",
                      "lockdiscovery",
                      "lockentry",
                      "lockscope",
                      "locktype",
                      "shared",
                      "supportedlock",
                      "write",
                    ].map((local) => `D:${local}`),
                  ]
                : ["g0:displayname", "g0:getcontentlength", "g1:missing"]),
            ].toSorted(),
          );
          expect(actual.body.toString("utf8").split("\n")).toHaveLength(3);
          expect(recorded.response.body.toString("utf8")).toContain(
            "%20&amp;%20",
          );
          expect(actual.body.toString("utf8")).toContain(
            "Café &amp; notes.txt",
          );
          ledger([recorded.request], yield* store.ledger);
        }),
    );

  for (const [kind, apacheAllow, docVaultAllow, apacheType] of [
    [
      "collection",
      "OPTIONS,GET,HEAD,POST,DELETE,TRACE,PROPFIND,PROPPATCH,COPY,MOVE,LOCK,UNLOCK",
      "OPTIONS, PROPFIND",
      "httpd/unix-directory",
    ],
    [
      "document",
      "OPTIONS,GET,HEAD,POST,DELETE,TRACE,PROPFIND,PROPPATCH,COPY,MOVE,PUT,LOCK,UNLOCK",
      "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND",
      "text/plain",
    ],
    ["unmapped", "OPTIONS,MKCOL,PUT,LOCK", "OPTIONS, PUT", "text/plain"],
  ])
    it.live(
      `[STAT-7] options-${kind}: full recorded Allow and DAV classes versus the restricted servlet`,
      () =>
        Effect.gen(function* () {
          const recorded = exchange(`options-${kind}`);
          const store = yield* lane.backend("soap-store", options);
          const actual = yield* dispatch(store.origin, recorded.request);
          compareWire(recorded.response, actual, [
            "header allow",
            "header content-type",
            "header dav",
            "header ms-author-via",
            "header server",
          ]);
          expect(header(recorded.response, "allow")).toEqual([apacheAllow]);
          expect(header(actual, "allow")).toEqual([docVaultAllow]);
          expect(header(recorded.response, "dav")).toEqual([
            "1,2",
            "<http://apache.org/dav/propset/fs/1>",
          ]);
          expect(header(actual, "dav")).toEqual(["1"]);
          expect(header(recorded.response, "ms-author-via")).toEqual(["DAV"]);
          expect(header(actual, "ms-author-via")).toEqual([]);
          expect(header(recorded.response, "content-type")).toEqual([
            apacheType,
          ]);
          expect(header(actual, "content-type")).toEqual([]);
          expect(header(actual, "content-length")).toEqual(["0"]);
          expect(actual.body).toEqual(Buffer.alloc(0));
          ledger([recorded.request], yield* store.ledger);
        }),
    );

  it.live(
    "[STAT-7] mkcol-existing: the same 405 with Apache's observed TRACE-only Allow pinned",
    () =>
      Effect.gen(function* () {
        const recorded = exchange("mkcol-existing");
        const store = yield* lane.backend("soap-store", options);
        const actual = yield* dispatch(store.origin, recorded.request);
        compareWire(recorded.response, actual, ["header allow", ...PAGE]);
        expect(actual.status).toBe(405);
        expect(header(recorded.response, "allow")).toEqual(["TRACE"]);
        expect(header(actual, "allow")).toEqual(["OPTIONS, PROPFIND"]);
        expect(header(recorded.response, "content-type")).toEqual([
          "text/html; charset=iso-8859-1",
        ]);
        expect(header(actual, "content-type")).toEqual(["text/plain"]);
        expect(actual.body.toString("utf8")).toBe("Method Not Allowed\r\n");
        expect(recorded.response.body.toString("latin1")).toContain(
          "The requested method MKCOL is not allowed for this URL.",
        );
        ledger([recorded.request], yield* store.ledger);
      }),
  );

  it.live(
    "[STAT-7] finite-depth: the same 403, Apache HTML versus the servlet's DAV error",
    () =>
      Effect.gen(function* () {
        const recorded = exchange("finite-depth");
        const store = yield* lane.backend("soap-store", options);
        const actual = yield* dispatch(store.origin, recorded.request);
        compareWire(recorded.response, actual, PAGE);
        expect(actual.status).toBe(403);
        expect(requestHeader(recorded.request, "depth")).toBeUndefined();
        expect(header(recorded.response, "content-type")).toEqual([
          "text/html; charset=ISO-8859-1",
        ]);
        expect(recorded.response.body.toString("latin1")).toContain(
          'PROPFIND requests with a Depth of "infinity" are not allowed for /dav/documents/.',
        );
        expect(header(actual, "content-type")).toEqual([XML]);
        expect(infoset(actual.body, () => false)).toEqual(
          prop("error", [prop("propfind-finite-depth")]),
        );
        expect(actual.body.toString("utf8")).toBe(
          '<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>\n',
        );
        ledger([recorded.request], yield* store.ledger);
      }),
  );

  it.live(
    "[RET-3] get-document: the same bytes and modification time with named opaque ETag differences",
    () =>
      Effect.gen(function* () {
        const recorded = exchange("get-document");
        const store = yield* lane.backend("soap-store", options);
        const actual = yield* dispatch(store.origin, recorded.request);
        compareWire(recorded.response, actual, READ);
        validators(recorded.response, actual);
        expect(actual.body).toEqual(recorded.response.body);
        expect(actual.body).toEqual(Buffer.from("synthetic report\n", "utf8"));
        expect(header(actual, "content-type")).toEqual(["text/plain"]);
        ledger([recorded.request], yield* store.ledger);
      }),
  );

  for (const name of [
    "get-not-modified-wildcard",
    "get-not-modified",
    "put-weak",
    "put-stale",
  ])
    it.live(
      `[RET-3] ${name}: recorded conditional semantics, with live-tag adaptation counted explicitly`,
      () =>
        Effect.gen(function* () {
          const recorded = exchange(name);
          const store = yield* lane.backend("soap-store", options);
          const requests: Array<Buffer> = [];
          let request = recorded.request;
          // Only the strong matching GET and current weak PUT need adaptation. Apache's filesystem
          // tag is replaced with DocVault's current opaque tag, discovered by a real preliminary GET.
          if (name === "get-not-modified" || name === "put-weak") {
            const setup = exchange("get-document");
            requests.push(setup.request);
            const current = yield* dispatch(store.origin, setup.request);
            compareWire(setup.response, current, READ);
            validators(setup.response, current);
            expect(current.body).toEqual(setup.response.body);
            const tag = header(current, "etag")[0]!;
            const field = name === "put-weak" ? "If-Match" : "If-None-Match";
            const prefix = name === "put-weak" ? "W/" : "";
            expect(requestHeader(request, field)).toBe(
              `${prefix}${APACHE_TAGS["report.txt"]}`,
            );
            request = replaceHeader(request, field, `${prefix}${tag}`);
            expect(requestHeader(request, field)).toBe(
              `${prefix}${TAGS["report.txt"]}`,
            );
          } else {
            expect(
              requestHeader(
                request,
                name === "put-stale" ? "If-Match" : "If-None-Match",
              ),
            ).toBe(name === "put-stale" ? '"stale"' : "*");
          }
          requests.push(request);
          const actual = yield* dispatch(store.origin, request);
          const put = name.startsWith("put-");
          compareWire(recorded.response, actual, put ? PAGE : CONDITIONAL);
          expect(actual.status).toBe(put ? 412 : 304);
          if (put) {
            expect(header(recorded.response, "content-type")).toEqual([
              "text/html; charset=iso-8859-1",
            ]);
            expect(recorded.response.body.toString("latin1")).toContain(
              "The precondition on the request for this URL evaluated to false.",
            );
            expect(header(actual, "content-type")).toEqual(["text/plain"]);
            expect(actual.body.toString("utf8")).toBe(
              "Precondition Failed\r\n",
            );
            // A failed precondition must not mutate bytes, type, modification time or validator.
            const verify = exchange("get-document");
            requests.push(verify.request);
            const unchanged = yield* dispatch(store.origin, verify.request);
            compareWire(verify.response, unchanged, READ);
            validators(verify.response, unchanged);
            expect(unchanged.body).toEqual(verify.response.body);
          } else {
            validators(recorded.response, actual);
            expect(actual.body).toEqual(Buffer.alloc(0));
            expect(recorded.response.body).toEqual(Buffer.alloc(0));
            for (const field of [
              "content-type",
              "content-length",
              "transfer-encoding",
            ])
              expect(header(actual, field)).toEqual([]);
          }
          expect(requests).toHaveLength(
            name === "put-weak"
              ? 3
              : name === "get-not-modified" || name === "put-stale"
                ? 2
                : 1,
          );
          ledger(requests, yield* store.ledger);
        }),
    );
});
