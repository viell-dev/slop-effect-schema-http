/**
 * Backend-side regression cases for the readers the corpora of EXT-3 to EXT-5 compare with
 * independent parsers: the SOAP store's and the gateway's XML readers, and the store's bundle
 * writer. The corpora in `src/formats/corpus/` hold the consumer side's cases; these hold the
 * backend fixes they do not cover. Each document states XML 1.0's verdict, citing the production
 * or constraint of https://www.w3.org/TR/xml/ that decides it, or the refusal the service page
 * documents, and the backend's verdict is read over HTTP.
 *
 * Node-only, like the other backend-side tests: a backend reads a document the same whichever lane
 * sends it, and the bundle checks search the raw bytes with Buffer and read them with Node's
 * formData().
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import { type XmlRpcValue, xmlRpcValues } from "./recordings.js";

interface ReaderCase {
  readonly id: string;
  readonly about: string;
  readonly document: string;
  /** Whether the backend must read the document: XML 1.0's verdict, or its page's refusal. */
  readonly reads: boolean;
  /** The text a read document makes the backend answer with. */
  readonly text?: string;
}

/** What a backend made of a document, as its HTTP answer shows. */
interface Observed {
  readonly reads: boolean;
  readonly text?: string;
  readonly detail: string;
}

const encoder = new TextEncoder();

/** The findings for every case whose verdict or answered text differs from the backend's. */
const judge = (kase: ReaderCase, observed: Observed): ReadonlyArray<string> =>
  observed.reads !== kase.reads ||
  (kase.text !== undefined && observed.text !== kase.text)
    ? [
        `${kase.id} (${kase.about}): ${kase.reads ? `should read${kase.text === undefined ? "" : ` and answer ${JSON.stringify(kase.text)}`}` : "should refuse"}, but ${observed.reads ? "reads" : "refuses"}: ${observed.detail}`,
      ]
    : [];

// The SOAP store (services/soap-store.md, "XML rules").

interface StoreParts {
  readonly declaration?: string;
  readonly prolog?: string;
  /** The whole `<Title>` element, as markup. */
  readonly title?: string;
  readonly epilog?: string;
}

const storeCall = (id: string, parts: StoreParts): string =>
  `${parts.declaration ?? '<?xml version="1.0" encoding="utf-8"?>'}${parts.prolog ?? ""}` +
  '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>' +
  `<StoreDocument xmlns="urn:docvault:store:2003"><Name>${id}.txt</Name>` +
  `${parts.title ?? "<Title>Title</Title>"}` +
  "<ContentType>text/plain</ContentType><Content>eA==</Content>" +
  `</StoreDocument></soap:Body></soap:Envelope>${parts.epilog ?? ""}`;

const store = (
  id: string,
  about: string,
  reads: boolean,
  parts: StoreParts,
  text?: string,
): ReaderCase => ({
  id,
  about,
  document: storeCall(id, parts),
  reads,
  ...(text === undefined ? {} : { text }),
});

const storeCases: ReadonlyArray<ReaderCase> = [
  store(
    "entity-constructor",
    "&constructor;, an entity no DTD declares, named like an Object.prototype member (WFC: Entity Declared)",
    false,
    { title: "<Title>&constructor;</Title>" },
  ),
  store(
    "entity-proto",
    "&__proto__;, declared nowhere either (WFC: Entity Declared)",
    false,
    { title: "<Title>a&__proto__;b</Title>" },
  ),
  store(
    "element-non-ascii",
    "an element with a non-ASCII name inside the title, whose text the store keeps ([4] NameStartChar, [4a] NameChar)",
    true,
    { title: "<Title>a<größe·x>b</größe·x>c</Title>" },
    "ac",
  ),
  store(
    "end-tag-nbsp",
    "U+00A0 before the end of an end tag: not white space ([42] ETag, [3] S)",
    false,
    { title: "<Title>Title</Title >" },
  ),
  store(
    "end-tag-space",
    "white space before the end of an end tag ([42] ETag)",
    true,
    { title: "<Title>Spaced</Title \n\t>" },
    "Spaced",
  ),
  store(
    "epilog-em-space",
    "U+2003 after the root: not white space ([27] Misc, [3] S)",
    false,
    { epilog: " " },
  ),
  store(
    "declaration-version-1-1",
    "version 1.1, which [26] VersionNum admits and a 1.0 processor reads as 1.0 (2.8)",
    true,
    { declaration: '<?xml version="1.1" encoding="utf-8"?>' },
    "Title",
  ),
  store("declaration-version-2", "version 2.0 ([26] VersionNum)", false, {
    declaration: '<?xml version="2.0"?>',
  }),
  store(
    "declaration-no-space",
    "no white space before the encoding ([80] EncodingDecl)",
    false,
    { declaration: '<?xml version="1.0"encoding="utf-8"?>' },
  ),
  store(
    "declaration-encoding-name",
    "an encoding name starting with '-' ([81] EncName)",
    false,
    { declaration: '<?xml version="1.0" encoding="-utf-8"?>' },
  ),
  store(
    "declaration-trailing-space",
    "white space before '?>' ([23] XMLDecl)",
    true,
    { declaration: "<?xml version='1.0' encoding='utf-8' ?>\n" },
    "Title",
  ),
  store(
    "declaration-upper-case",
    "'<?XML' at the start: not a declaration, and a reserved target ([23] XMLDecl, [17] PITarget)",
    false,
    { declaration: '<?XML version="1.0"?>' },
  ),
  store(
    "pi-no-space",
    "data straight after a processing instruction's target ([16] PI)",
    false,
    { prolog: '<?route"archive"?>' },
  ),
  store(
    "pi-no-data",
    "a processing instruction with a target and no data ([16] PI)",
    true,
    { prolog: "<?route?>" },
    "Title",
  ),
  store(
    "pi-reserved-in-content",
    "'xml' as the target of a processing instruction inside the title ([17] PITarget)",
    false,
    { title: "<Title>a<?xml note?>b</Title>" },
  ),
  store(
    "comment-single-hyphens",
    "single hyphens inside a comment ([15] Comment)",
    true,
    { prolog: "<!-- a - b -->" },
    "Title",
  ),
  store(
    "comment-epilog-double-hyphen",
    "'--' inside a comment after the root ([15] Comment)",
    false,
    { epilog: "<!-- a -- b -->" },
  ),
  store(
    "doctype-after-comment",
    "a DTD after a comment: well-formed, but SOAP forbids one and the store reads none",
    false,
    { prolog: "<!-- c --><!DOCTYPE soap:Envelope>" },
  ),
];

/**
 * Send a document as a SOAP 1.1 `StoreDocument` call. A plain-text 400 starting "Malformed XML" is
 * the store's parse error; the title of a stored document is read back from its bundle's JSON.
 */
const storeReads = (origin: string, document: string) =>
  Effect.promise(async (): Promise<Observed> => {
    const response = await fetch(`${origin}/soap`, {
      method: "POST",
      headers: {
        "content-type": "text/xml; charset=utf-8",
        soapaction: '"urn:docvault:store:2003#StoreDocument"',
      },
      body: encoder.encode(document),
    });
    const body = Buffer.from(await response.arrayBuffer()).toString("latin1");
    if (response.status === 400 && body.startsWith("Malformed XML"))
      return { reads: false, detail: body };
    const id = /<DocumentId>([^<]*)<\/DocumentId>/.exec(body)?.[1];
    if (response.status !== 200 || id === undefined)
      return { reads: true, detail: `${response.status} ${body}` };
    const bundle = await (await fetch(`${origin}/bundle/${id}`)).formData();
    const { title } = JSON.parse(
      await (bundle.get("metadata") as File).text(),
    ) as { readonly title: string };
    return { reads: true, text: title, detail: `stored as ${id}` };
  });

// The gateway (services/gateway.md, "XML rules").

const ACCOUNT = "12345678";
const TITLE = "Acme Holdings";
const TOKEN = "sso-readers";

interface CallParts {
  readonly declaration?: string;
  readonly prolog?: string;
  /** Inside `<methodCall>`, before `<methodName>`. */
  readonly before?: string;
  /** The whole `<methodName>` element, as markup. */
  readonly method?: string;
  /** The parameter's `<value>` content, as markup. */
  readonly value?: string;
  readonly epilog?: string;
}

const gatewayCall = (parts: CallParts): string =>
  `${parts.declaration ?? '<?xml version="1.0"?>\n'}${parts.prolog ?? ""}` +
  `<methodCall>${parts.before ?? ""}${parts.method ?? "<methodName>account.title</methodName>"}` +
  `<params><param><value>${parts.value ?? `<string>${ACCOUNT}</string>`}</value></param></params>` +
  `</methodCall>${parts.epilog ?? ""}`;

/** An `account.title` call for the known account, which a reading answers with its title. */
const gateway = (
  id: string,
  about: string,
  reads: boolean,
  parts: CallParts,
): ReaderCase => ({
  id,
  about,
  document: gatewayCall(parts),
  reads,
  ...(reads ? { text: TITLE } : {}),
});

const gatewayCases: ReadonlyArray<ReaderCase> = [
  gateway(
    "pi-in-string",
    "a processing instruction inside the account, whose text runs on around it ([43] content)",
    true,
    { value: "<string>1234<?trace x?>5678</string>" },
  ),
  gateway(
    "comment-in-method-name",
    "a comment inside the method name ([43] content)",
    true,
    { method: "<methodName>account<!-- x -->.title</methodName>" },
  ),
  gateway(
    "greater-than-in-attribute",
    "'>' in an attribute value, which does not end the tag ([10] AttValue)",
    true,
    { method: '<methodName kind="a>b">account.title</methodName>' },
  ),
  gateway(
    "cdata-end-in-attribute",
    "']]>' in an attribute value, which only character data forbids ([10] AttValue)",
    true,
    { method: "<methodName kind=']]>'>account.title</methodName>" },
  ),
  gateway(
    "end-tag-space",
    "white space before the end of an end tag ([42] ETag)",
    true,
    { value: `<string>${ACCOUNT}</string \n\t>` },
  ),
  gateway(
    "non-ascii-names",
    "a non-ASCII attribute name and an unknown element with one ([4] NameStartChar, [4a] NameChar)",
    true,
    {
      before: "<größe·x/>",
      method: '<methodName größe="x">account.title</methodName>',
    },
  ),
  gateway(
    "end-tag-nbsp",
    "U+00A0 before the end of an end tag: not white space ([42] ETag, [3] S)",
    false,
    { value: `<string>${ACCOUNT}</string >` },
  ),
  gateway(
    "epilog-ideographic-space",
    "U+3000 after the root: not white space ([27] Misc, [3] S)",
    false,
    { epilog: "　" },
  ),
  gateway(
    "prolog-zero-width-space",
    "U+FEFF after the declaration: a character, not a signature ([22] prolog)",
    false,
    { prolog: "﻿" },
  ),
  gateway(
    "declaration-order",
    "a declaration naming the encoding before the version ([23] XMLDecl)",
    false,
    { declaration: '<?xml encoding="utf-8" version="1.0"?>' },
  ),
  gateway("declaration-standalone", "standalone='maybe' ([32] SDDecl)", false, {
    declaration: '<?xml version="1.0" standalone="maybe"?>',
  }),
  gateway(
    "declaration-full",
    "a declaration with version, encoding and standalone ([23] XMLDecl)",
    true,
    { declaration: "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>" },
  ),
  gateway(
    "pi-reserved",
    "'XmL' as a processing instruction's target ([17] PITarget)",
    false,
    { prolog: "<?XmL data?>" },
  ),
  gateway(
    "pi-no-target",
    "a processing instruction without a target ([16] PI)",
    false,
    { prolog: "<? data?>" },
  ),
  gateway(
    "pi-reserved-in-string",
    "'xml' as the target of a processing instruction inside the account ([17] PITarget)",
    false,
    { value: "<string>1234<?xml x?>5678</string>" },
  ),
  gateway(
    "comment-hyphen-end",
    "a comment ending in '--->' before the root ([15] Comment)",
    false,
    { prolog: "<!-- a --->" },
  ),
  gateway(
    "comment-epilog-double-hyphen",
    "'--' inside a comment after the root ([15] Comment)",
    false,
    { epilog: "<!-- a -- b -->" },
  ),
  gateway(
    "doctype-after-comment",
    "a DTD after a comment: well-formed, but the gateway refuses every DTD, as its page documents",
    false,
    { prolog: "<!-- c --><!DOCTYPE methodCall>" },
  ),
];

/** A scalar's text, typed as a string or untyped. */
const text = (value: XmlRpcValue | undefined): string | undefined =>
  value === undefined
    ? undefined
    : "untyped" in value
      ? value.untyped
      : "string" in value
        ? value.string
        : undefined;

/** Send a call to `/RPC2`. The -32700 fault is its parse error; other answers carry text. */
const gatewayReads = (origin: string, document: string) =>
  Effect.promise(async (): Promise<Observed> => {
    const response = await fetch(`${origin}/RPC2?session=${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "text/xml" },
      body: encoder.encode(document),
    });
    const body = Buffer.from(await response.arrayBuffer());
    if (response.status !== 200)
      return { reads: true, detail: `${response.status} ${body.toString()}` };
    const reply = xmlRpcValues(body);
    if ("params" in reply) {
      const result = text(reply.params[0]);
      return {
        reads: true,
        ...(result === undefined ? {} : { text: result }),
        detail: "a result",
      };
    }
    const members = new Map("struct" in reply.fault ? reply.fault.struct : []);
    const code = members.get("faultCode");
    const message = text(members.get("faultString")) ?? "";
    const detail = `fault ${JSON.stringify(code)} ${message}`;
    return code !== undefined && "int" in code && code.int === "-32700"
      ? { reads: false, detail }
      : { reads: true, text: message, detail };
  });

// The store's bundles (services/soap-store.md, "The file endpoints").

const USUAL = "--DocVaultBundle-DOC-000001-1";

interface BundleCase {
  readonly about: string;
  readonly document: {
    readonly name: string;
    readonly title: string;
    readonly contentType: string;
    readonly text: string;
  };
  /** The boundary the store must choose. */
  readonly boundary: string;
}

const bundleCases: ReadonlyArray<BundleCase> = [
  {
    about: "content holding the usual delimiter and its first numbered variant",
    document: {
      name: "nested.txt",
      title: "Nested",
      contentType: "text/plain",
      text: `a\r\n${USUAL}\r\nb\r\n${USUAL}-2\r\nc\r\n${USUAL}-2--\r\n`,
    },
    boundary: "DocVaultBundle-DOC-000001-1-3",
  },
  {
    about: "a title holding the usual delimiter, in the JSON metadata part",
    document: {
      name: "titled.txt",
      title: "--DocVaultBundle-DOC-000002-1 in the title",
      contentType: "text/plain",
      text: "plain",
    },
    boundary: "DocVaultBundle-DOC-000002-1-2",
  },
  {
    about: "content holding the delimiter of another document's bundle",
    document: {
      name: "other.txt",
      title: "Other",
      contentType: "text/plain",
      text: `${USUAL}\r\n`,
    },
    boundary: "DocVaultBundle-DOC-000003-1",
  },
];

/** Every index at which `needle` occurs in `haystack`. */
const occurrences = (
  haystack: Buffer,
  needle: string,
): ReadonlyArray<number> => {
  const found: Array<number> = [];
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + 1)
  )
    found.push(at);
  return found;
};

describe("backend-side reader regressions", () => {
  it.live(
    "[EXT-3] the store's XML reader gives XML 1.0's verdict on the backend-side cases the corpus does not hold, and refuses a DTD as SOAP requires",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("soap-store", {});
        const findings: Array<string> = [];
        for (const kase of storeCases)
          findings.push(
            ...judge(kase, yield* storeReads(backend.origin, kase.document)),
          );
        expect(findings).toEqual([]);
        // The cases hold both verdicts, and the store judged exactly these bytes.
        expect(new Set(storeCases.map((kase) => kase.reads))).toEqual(
          new Set([true, false]),
        );
        const posted = (yield* backend.ledger).filter(
          (recorded) => recorded.method === "POST",
        );
        expect(posted.map((recorded) => recorded.body)).toEqual(
          storeCases.map((kase) => encoder.encode(kase.document)),
        );
      }),
  );

  it.live(
    "[EXT-4] the gateway's XML-RPC reader gives XML 1.0's verdict on the backend-side cases the corpus does not hold, and refuses a DTD as its page documents",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("gateway", {
          token: TOKEN,
          accounts: [
            { account: ACCOUNT, title: TITLE, cents: 100, due: "00000000" },
          ],
        });
        const findings: Array<string> = [];
        for (const kase of gatewayCases)
          findings.push(
            ...judge(kase, yield* gatewayReads(backend.origin, kase.document)),
          );
        expect(findings).toEqual([]);
        expect(new Set(gatewayCases.map((kase) => kase.reads))).toEqual(
          new Set([true, false]),
        );
        const posted = (yield* backend.ledger).filter(
          (recorded) => recorded.method === "POST",
        );
        expect(posted.map((recorded) => recorded.body)).toEqual(
          gatewayCases.map((kase) => encoder.encode(kase.document)),
        );
      }),
  );

  it.live(
    "[EXT-5] the store's bundle boundary occurs in no part: a numbered variant when the content or the metadata holds the usual one (RFC 2046 section 5.1.1)",
    () =>
      Effect.gen(function* () {
        const backend = yield* lane.backend("soap-store", {
          documents: bundleCases.map(({ document }) => document),
        });
        for (const [index, kase] of bundleCases.entries()) {
          const id = `DOC-${String(index + 1).padStart(6, "0")}`;
          const { type, body } = yield* Effect.promise(async () => {
            const response = await fetch(`${backend.origin}/bundle/${id}`);
            return {
              type: response.headers.get("content-type") ?? "",
              body: Buffer.from(await response.arrayBuffer()),
            };
          });
          expect([kase.about, type]).toEqual([
            kase.about,
            `multipart/form-data; boundary=${kase.boundary}`,
          ]);
          // The delimiter occurs only as the two delimiter lines and the close delimiter.
          const delimiter = `--${kase.boundary}`;
          const parts = body.indexOf("\r\n\r\n");
          expect([kase.about, occurrences(body, delimiter)]).toEqual([
            kase.about,
            [
              0,
              body.indexOf(`\r\n${delimiter}\r\n`, parts) + 2,
              body.length - delimiter.length - 4,
            ],
          ]);
          const form = yield* Effect.promise(() =>
            new Response(new Uint8Array(body), {
              headers: { "content-type": type },
            }).formData(),
          );
          const metadata = JSON.parse(
            yield* Effect.promise(() => (form.get("metadata") as File).text()),
          ) as { readonly title: string };
          const content = yield* Effect.promise(() =>
            (form.get("content") as File).text(),
          );
          expect([kase.about, metadata.title, content]).toEqual([
            kase.about,
            kase.document.title,
            kase.document.text,
          ]);
        }
      }),
  );
});
