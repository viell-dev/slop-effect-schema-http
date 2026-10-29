/**
 * The suite's own readers checked against parsers it did not write (EXT-3, EXT-4, EXT-5). The
 * consumer and each backend have hand-written XML, XML-RPC and multipart readers by the same
 * authors, so a gap they share passes every round trip between them. Here every reader is compared
 * with an independent parser instead, never with the other:
 *
 * - XML and XML-RPC: saxes in the Node lane and Chromium's DOMParser in the browser lane
 *   (`src/formats/independent.ts`) read each document of the corpora in `src/formats/corpus/`. The
 *   consumer's reader must agree on acceptance and on the decoded tree; the backend's reader, seen
 *   only over HTTP, on acceptance and on the decoded text it reports back.
 * - Multipart: `Response.formData()`, the platform's parser in each lane, reads the upload bodies
 *   the consumer sent, as the backend's ledger recorded them, and the bundles the store returns.
 *
 * A reader known to disagree is recorded in the corpus case with its reason, and in CATALOGUE.md.
 */
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { lane } from "#lane";
import { Files } from "../clients/soap-store/index.js";
import {
  bundleCases,
  type FormParser,
  uploadCases,
} from "../formats/corpus/multipart.js";
import { type Case, type Reader, xmlCorpus } from "../formats/corpus/xml.js";
import {
  ACCOUNT,
  ACCOUNT_TITLE,
  INVOICE,
  xmlRpcCorpus,
} from "../formats/corpus/xmlrpc.js";
import { domParser, normalize, saxes } from "../formats/independent.js";
import * as Xml from "../formats/xml.js";
import * as XmlRpc from "../formats/xmlrpc.js";
import { header } from "../harness/lane.js";

/** The lane's independent XML parser. */
const independent = lane.name === "browser" ? domParser : saxes;

/** The lane's own multipart parser, `Response.formData()`. */
const formParser: { readonly key: FormParser; readonly name: string } =
  lane.name === "browser"
    ? { key: "Chromium", name: "Chromium's formData()" }
    : { key: "undici", name: "Node's formData() (undici)" };

const encoder = new TextEncoder();

/** ISO-8859-1 by hand: one code point per byte. */
const latin1 = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");

/** Deep equality of plain data, comparing own keys only, so `__proto__` is an ordinary key. */
const same = (a: unknown, b: unknown): boolean => {
  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null
  )
    return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) =>
        Object.hasOwn(b, key) &&
        same(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        ),
    )
  );
};

const show = (value: unknown): string => JSON.stringify(value) ?? "undefined";

type Attempt<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: string };

const attempt = <A>(run: () => A): Attempt<A> => {
  try {
    return { ok: true, value: run() };
  } catch (cause) {
    return { ok: false, error: (cause as Error).message };
  }
};

/**
 * The verdict a reader is compared with: the independent parser's reading, or XML 1.0's verdict
 * where the case records the independent parser as wrong. Its tree is then unknown.
 */
type Reference =
  | { readonly accepted: true; readonly root?: Xml.Element }
  | { readonly accepted: false; readonly error: string };

const describeReading = (reading: Reference): string =>
  reading.accepted
    ? `accepts${reading.root === undefined ? "" : ` ${show(reading.root)}`}`
    : `refuses (${reading.error})`;

/** The reference for a case, and a finding when the independent parser misjudges it. */
const referenceFor = (
  kase: Case,
): { readonly reference: Reference; readonly finding?: string } => {
  const reading = independent.read(kase.document);
  const known = kase.disagreements?.[independent.key];
  if (reading.accepted === kase.wellFormed)
    return known === undefined
      ? { reference: reading }
      : {
          reference: reading,
          finding: `${kase.id}: ${independent.name} now gives XML 1.0's verdict; drop the recorded disagreement (${known})`,
        };
  const finding =
    known === undefined
      ? `${kase.id} (${kase.about}): XML 1.0 says ${kase.wellFormed ? "well-formed" : "malformed"}, but ${independent.name} ${describeReading(reading)}`
      : undefined;
  const reference: Reference = kase.wellFormed
    ? { accepted: true }
    : { accepted: false, error: "malformed by XML 1.0" };
  return finding === undefined ? { reference } : { reference, finding };
};

/**
 * Record whether `reader` agrees with the reference on `kase`: a finding for an unrecorded
 * disagreement, and for a recorded one that no longer holds.
 */
const judge = (
  findings: Array<string>,
  kase: Case,
  reader: Reader,
  agrees: boolean,
  said: string,
  reference: string,
) => {
  const known = kase.disagreements?.[reader];
  if (!agrees && known === undefined)
    findings.push(
      `${kase.id} (${kase.about}): the ${reader} ${said}, but ${independent.name} ${reference}`,
    );
  if (agrees && known !== undefined)
    findings.push(
      `${kase.id}: the ${reader} now agrees with ${independent.name}; drop the recorded disagreement (${known})`,
    );
};

/** The first element with a local name, depth first. */
const find = (root: Xml.Element, local: string): Xml.Element | undefined => {
  if (Xml.localName(root.name) === local) return root;
  for (const child of Xml.elements(root)) {
    const found = find(child, local);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** What a backend made of a document, as its HTTP answer shows. */
interface Observed {
  /** Whether it read the document as well-formed XML. */
  readonly accepted: boolean;
  /** The decoded text it reported back, when its answer carries one. */
  readonly text?: string;
  readonly detail: string;
}

describe("independent parsers", () => {
  describe("EXT-3: the XML corpus", () => {
    it(`[EXT-3] ${independent.name} gives XML 1.0's verdict on every document of the XML corpus, except its recorded disagreements`, () => {
      const findings = xmlCorpus.flatMap(
        (kase) => referenceFor(kase).finding ?? [],
      );
      expect(findings).toEqual([]);
      // The corpus can fail: it holds both verdicts.
      expect(new Set(xmlCorpus.map((kase) => kase.wellFormed))).toEqual(
        new Set([true, false]),
      );
    });

    it(`[EXT-3] the consumer's XML reader agrees with ${independent.name} on every document: acceptance, and the decoded tree when accepted`, () => {
      const findings: Array<string> = [];
      for (const kase of xmlCorpus) {
        const { reference } = referenceFor(kase);
        const parsed = attempt(() => normalize(Xml.parse(kase.document)));
        const reading: Reference = parsed.ok
          ? { accepted: true, root: parsed.value }
          : { accepted: false, error: parsed.error };
        const agrees =
          reading.accepted === reference.accepted &&
          (!reading.accepted ||
            !reference.accepted ||
            reference.root === undefined ||
            same(reading.root, reference.root));
        judge(
          findings,
          kase,
          "consumer",
          agrees,
          describeReading(reading),
          describeReading(reference),
        );
      }
      expect(findings).toEqual([]);
    });

    it.live(
      `[EXT-3] the store's XML reader agrees with ${independent.name} on every document, judged over HTTP: a "Malformed XML" 400, or the title it stored`,
      () =>
        Effect.gen(function* () {
          const backend = yield* lane.backend("soap-store", {});
          const findings: Array<string> = [];
          for (const kase of xmlCorpus) {
            const { reference } = referenceFor(kase);
            const observed = yield* storeReads(backend.origin, kase.document);
            const title =
              reference.accepted && reference.root !== undefined
                ? Xml.textOf(find(reference.root, "Title")!)
                : undefined;
            const agrees =
              observed.accepted === reference.accepted &&
              (!reference.accepted ||
                (observed.text !== undefined &&
                  (title === undefined || observed.text === title)));
            judge(
              findings,
              kase,
              "store",
              agrees,
              observed.accepted
                ? `accepts and stores the title ${show(observed.text)} (${observed.detail})`
                : `refuses (${observed.detail})`,
              reference.accepted
                ? `accepts the title ${show(title)}`
                : describeReading(reference),
            );
          }
          expect(findings).toEqual([]);
          // The store judged exactly these bytes.
          const posted = (yield* backend.ledger).filter(
            (recorded) => recorded.method === "POST",
          );
          expect(posted.map((recorded) => recorded.body)).toEqual(
            xmlCorpus.map((kase) => encoder.encode(kase.document)),
          );
        }),
    );
  });

  describe("EXT-4: the XML-RPC corpus", () => {
    it(`[EXT-4] ${independent.name} gives XML 1.0's verdict on every call and reply of the XML-RPC corpus, except its recorded disagreements`, () => {
      const findings = xmlRpcCorpus.flatMap(
        (kase) => referenceFor(kase).finding ?? [],
      );
      expect(findings).toEqual([]);
      expect(new Set(xmlRpcCorpus.map((kase) => kase.wellFormed))).toEqual(
        new Set([true, false]),
      );
    });

    it(`[EXT-4] the consumer's XML-RPC reader agrees with ${independent.name} on every call and reply, and reads the values the specification gives`, () => {
      const findings: Array<string> = [];
      for (const kase of xmlRpcCorpus) {
        const { reference } = referenceFor(kase);
        const read = (root: Xml.Element) =>
          kase.kind === "call" ? XmlRpc.callOf(root) : XmlRpc.responseOf(root);
        const parsed = attempt(() =>
          kase.kind === "call"
            ? XmlRpc.parseCall(kase.document)
            : XmlRpc.parseResponse(kase.document),
        );
        // A refusal of the XML-RPC structure means the XML itself was read.
        const xmlAccepted = parsed.ok || parsed.error.startsWith("XML-RPC:");
        // The same XML-RPC reading over the independent parser's tree isolates the XML layer.
        const expected =
          reference.accepted && reference.root !== undefined
            ? attempt(() => read(reference.root!))
            : undefined;
        const agrees =
          xmlAccepted === reference.accepted &&
          (expected === undefined || same(parsed, expected));
        judge(
          findings,
          kase,
          "consumer",
          agrees,
          parsed.ok
            ? `reads ${show(parsed.value)}`
            : `refuses (${parsed.error})`,
          expected === undefined
            ? describeReading(reference)
            : expected.ok
              ? `reads ${show(expected.value)}`
              : `reads XML that the XML-RPC layer refuses (${expected.error})`,
        );
        if (kase.xmlrpc !== undefined) {
          const value = !parsed.ok
            ? undefined
            : "methodName" in parsed.value
              ? parsed.value.params[0]
              : "params" in parsed.value
                ? parsed.value.params[0]
                : undefined;
          const meets =
            "value" in kase.xmlrpc
              ? parsed.ok && same(value, kase.xmlrpc.value)
              : !parsed.ok && parsed.error.startsWith(kase.xmlrpc.refused);
          if (!meets)
            findings.push(
              `${kase.id} (${kase.about}): the specification gives ${show(kase.xmlrpc)}, but the consumer ${parsed.ok ? `reads ${show(value)}` : `refuses (${parsed.error})`}`,
            );
        }
      }
      expect(findings).toEqual([]);
    });

    it.live(
      `[EXT-4] the gateway's XML-RPC reader agrees with ${independent.name} on every call, judged over HTTP: the parse-error fault, or the decoded text it answers with`,
      () =>
        Effect.gen(function* () {
          const backend = yield* lane.backend("gateway", gatewayOptions);
          const findings: Array<string> = [];
          const calls = xmlRpcCorpus.filter((kase) => kase.kind === "call");
          for (const kase of calls) {
            const { reference } = referenceFor(kase);
            const observed = yield* gatewayReads(backend.origin, kase.document);
            // A call whose XML-RPC structure is invalid has no echo to expect, only acceptance.
            const call =
              reference.accepted && reference.root !== undefined
                ? attempt(() => XmlRpc.callOf(reference.root!))
                : undefined;
            const expected = call?.ok ? expectedEcho(call.value) : undefined;
            const agrees =
              observed.accepted === reference.accepted &&
              (expected === undefined || observed.text === expected);
            judge(
              findings,
              kase,
              "gateway",
              agrees,
              observed.accepted
                ? `accepts and answers ${show(observed.text)} (${observed.detail})`
                : `refuses (${observed.detail})`,
              reference.accepted
                ? `accepts${expected === undefined ? "" : `, so the answer should read ${show(expected)}`}`
                : describeReading(reference),
            );
          }
          expect(findings).toEqual([]);
          const posted = (yield* backend.ledger).filter(
            (recorded) => recorded.method === "POST",
          );
          expect(posted.map((recorded) => recorded.body)).toEqual(
            calls.map((kase) => encoder.encode(kase.document)),
          );
        }),
    );
  });

  describe("EXT-5: multipart", () => {
    for (const [provider, layer] of lane.clients)
      it.live(
        `[EXT-5] ${formParser.name} reads the upload bodies the consumer sends through ${provider}, from the ledger, as the store read them: label, file name, type and bytes`,
        () =>
          Effect.gen(function* () {
            const backend = yield* lane.backend("soap-store", {});
            const findings: Array<string> = [];
            for (const kase of uploadCases) {
              const answer = yield* Files.upload(backend.origin)
                .execute({ label: kase.label, file: kase.file })
                .pipe(Effect.provide(layer));
              const recorded = (yield* backend.ledger).at(-1)!;
              expect(recorded.target).toBe("/upload");
              const read = yield* Effect.promise(() =>
                readForm(
                  recorded.body,
                  header(recorded.lines, "content-type") ?? "",
                ),
              );
              const stored = yield* storeUpload(backend.origin, answer);

              // What the store made of the upload, as its answer and the stored document show.
              const expected =
                "refused" in kase.store
                  ? kase.store
                  : {
                      label: kase.store.label ?? kase.label,
                      name: kase.store.name ?? kase.file.name,
                      type: kase.store.type ?? kase.file.type,
                      bytes: kase.file.bytes,
                    };
              const documented =
                "refused" in expected
                  ? "refused" in stored &&
                    stored.refused.startsWith(expected.refused)
                  : !("refused" in stored) &&
                    stored.label === expected.label &&
                    stored.name === expected.name &&
                    stored.type === expected.type &&
                    same(stored.bytes, expected.bytes) &&
                    stored.size === expected.bytes.length;
              if (!documented)
                findings.push(
                  `${kase.id} (${kase.about}): the store answers ${showUpload(stored)}, not ${showUpload(expected)}`,
                );

              // The platform's reading of the recorded body against the store's.
              const [label, file] = read.accepted ? read.parts : [];
              const shape =
                read.accepted &&
                read.parts.length === 2 &&
                label?.name === "label" &&
                "value" in label &&
                file?.name === "file" &&
                "fileName" in file;
              const agrees =
                shape &&
                ("refused" in stored
                  ? stored.refused === `Invalid document name ${file.fileName}`
                  : stored.label === label.value &&
                    stored.name === file.fileName &&
                    stored.type === file.type &&
                    same(stored.bytes, file.bytes));
              judgeForm(
                findings,
                kase,
                formParser.key,
                agrees,
                read.accepted ? show(read.parts) : `refuses (${read.error})`,
                showUpload(stored),
              );
            }
            expect(findings).toEqual([]);
          }),
      );

    it.live(
      `[EXT-5] ${formParser.name} reads the store's bundles as the store's own record has them, and the consumer's bundle operation reads them as ${formParser.name} does`,
      () =>
        Effect.gen(function* () {
          const backend = yield* lane.backend("soap-store", {
            documents: bundleCases.map(({ document }) => document),
          });
          const findings: Array<string> = [];
          for (const [index, kase] of bundleCases.entries()) {
            const id = `DOC-${String(index + 1).padStart(6, "0")}`;
            const raw = yield* Effect.promise(async () => {
              const response = await fetch(`${backend.origin}/bundle/${id}`);
              return {
                status: response.status,
                type: response.headers.get("content-type") ?? "",
                bytes: new Uint8Array(await response.arrayBuffer()),
              };
            });
            expect([kase.id, raw.status]).toEqual([kase.id, 200]);
            const read = yield* Effect.promise(() =>
              readForm(raw.bytes, raw.type),
            );
            const bundle = read.accepted ? bundleOf(read.parts) : undefined;

            // The platform's reading against the store's own record of the document.
            const record = kase.document;
            const content = Uint8Array.from(atob(record.base64), (char) =>
              char.charCodeAt(0),
            );
            const agrees =
              bundle !== undefined &&
              same(
                {
                  id: bundle.metadata["id"],
                  name: bundle.metadata["name"],
                  title: bundle.metadata["title"],
                  contentType: bundle.metadata["contentType"],
                  size: bundle.metadata["size"],
                },
                {
                  id,
                  name: record.name,
                  title: record.title,
                  contentType: record.contentType,
                  size: content.length,
                },
              ) &&
              bundle.fileName === record.name &&
              bundle.contentType === record.contentType &&
              same(bundle.content, content);
            judgeForm(
              findings,
              kase,
              kase.disagreements?.store === undefined
                ? formParser.key
                : "store",
              agrees,
              bundle !== undefined
                ? `reads ${show({ ...bundle, content: latin1(bundle.content) })}`
                : read.accepted
                  ? `reads parts ${show(read.parts)}`
                  : `refuses the bundle (${read.error})`,
              `holds ${show({ ...record, base64: undefined, id })}`,
            );

            // The consumer reads bundles through the library's form-data decoder; it must read what
            // the platform's parser reads, whichever provider carries it.
            for (const [provider, layer] of lane.clients) {
              const result = yield* Files.bundle(backend.origin)
                .execute(id)
                .pipe(Effect.provide(layer), Effect.result);
              const consumer =
                result._tag === "Success" && result.success._tag === "Bundle"
                  ? result.success
                  : undefined;
              // A body the platform cannot parse is a decode error, not another outcome.
              const failure =
                result._tag === "Failure" ? result.failure._tag : undefined;
              const readsAlike =
                bundle === undefined
                  ? failure === "DecodeError"
                  : consumer !== undefined &&
                    consumer.metadata.name === bundle.metadata["name"] &&
                    consumer.metadata.title === bundle.metadata["title"] &&
                    consumer.fileName === bundle.fileName &&
                    consumer.contentType === bundle.contentType &&
                    same(consumer.content, bundle.content);
              if (!readsAlike)
                findings.push(
                  `${kase.id} (${kase.about}): the consumer's bundle operation through ${provider} ${
                    consumer === undefined
                      ? `ends with ${failure ?? show(result)}`
                      : `reads ${show({ fileName: consumer.fileName, contentType: consumer.contentType, content: latin1(consumer.content) })}`
                  }, but ${formParser.name} ${bundle === undefined ? "refuses it, which should be a decode error" : `reads ${show({ fileName: bundle.fileName, contentType: bundle.contentType, content: latin1(bundle.content) })}`}`,
                );
            }
          }
          expect(findings).toEqual([]);
        }),
    );
  });
});

type Part =
  | { readonly name: string; readonly value: string }
  | {
      readonly name: string;
      readonly fileName: string;
      readonly type: string;
      readonly bytes: Uint8Array;
    };

/** Read a multipart body with the lane's `Response.formData()`. */
const readForm = async (
  body: Uint8Array,
  contentType: string,
): Promise<
  | { readonly accepted: true; readonly parts: ReadonlyArray<Part> }
  | { readonly accepted: false; readonly error: string }
> => {
  try {
    const form = await new Response(new Uint8Array(body), {
      headers: { "content-type": contentType },
    }).formData();
    const parts: Array<Part> = [];
    for (const [name, value] of form.entries())
      parts.push(
        typeof value === "string"
          ? { name, value }
          : {
              name,
              fileName: value.name,
              type: value.type,
              bytes: new Uint8Array(await value.arrayBuffer()),
            },
      );
    return { accepted: true, parts };
  } catch (cause) {
    return { accepted: false, error: String(cause) };
  }
};

/** A bundle's two parts as the platform read them, with the metadata parsed by `JSON.parse`. */
const bundleOf = (parts: ReadonlyArray<Part>) => {
  const [metadata, content] = parts;
  if (
    parts.length !== 2 ||
    metadata?.name !== "metadata" ||
    !("fileName" in metadata) ||
    content?.name !== "content" ||
    !("fileName" in content)
  )
    return undefined;
  return {
    metadata: JSON.parse(new TextDecoder().decode(metadata.bytes)) as Record<
      string,
      unknown
    >,
    fileName: content.fileName,
    contentType: content.type,
    content: content.bytes,
  };
};

/** What the store made of an upload: what it stored, or its refusal. */
type StoredUpload =
  | {
      readonly label: string;
      readonly name: string;
      readonly type: string;
      readonly bytes: Uint8Array;
      readonly size: number;
    }
  | { readonly refused: string };

const showUpload = (
  upload:
    | StoredUpload
    | {
        readonly label: string;
        readonly name: string;
        readonly type: string;
        readonly bytes: Uint8Array;
      },
): string =>
  "refused" in upload
    ? `a refusal (${show(upload.refused)})`
    : show({ ...upload, bytes: latin1(upload.bytes) });

/**
 * The store's reading of an upload: the label, name and size it answered, and the type and bytes
 * of the document it stored, fetched raw from the WebDAV view; or the reason it refused.
 */
const storeUpload = (
  origin: string,
  answer:
    | {
        readonly _tag: "Uploaded";
        readonly name: string;
        readonly label: string;
        readonly size: number;
      }
    | { readonly _tag: string; readonly reason: string },
) =>
  Effect.promise(async (): Promise<StoredUpload> => {
    if (!("name" in answer)) return { refused: answer.reason };
    const response = await fetch(
      `${origin}/dav/documents/${encodeURIComponent(answer.name)}`,
    );
    return {
      label: answer.label,
      name: answer.name,
      size: answer.size,
      type: response.headers.get("content-type") ?? "",
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  });

/** As {@link judge}, for the multipart cases' own disagreement keys. */
const judgeForm = (
  findings: Array<string>,
  kase: {
    readonly id: string;
    readonly about: string;
    readonly disagreements?: Partial<Record<string, string>>;
  },
  key: string,
  agrees: boolean,
  said: string,
  store: string,
) => {
  const known = kase.disagreements?.[key];
  if (!agrees && known === undefined)
    findings.push(
      `${kase.id} (${kase.about}): ${formParser.name} ${said}, but the store ${store}`,
    );
  if (agrees && known !== undefined)
    findings.push(
      `${kase.id}: ${formParser.name} now reads it as the store does; drop the recorded disagreement (${known})`,
    );
};

/**
 * Send a corpus document to the store as a SOAP 1.1 `StoreDocument` call. A plain-text 400 that
 * starts with "Malformed XML" is its parse error; a stored document's title is read back from its
 * bundle's JSON metadata, so no XML reader of the suite sees it.
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
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.status !== 200) {
      const text = new TextDecoder().decode(bytes).trim();
      return {
        accepted: !(
          response.status === 400 && text.startsWith("Malformed XML")
        ),
        detail: `${response.status} ${text}`,
      };
    }
    const reply = independent.read(latin1(bytes));
    if (!reply.accepted)
      return { accepted: true, detail: `an unreadable reply: ${reply.error}` };
    const code = Xml.textOf(find(reply.root, "FaultCode")!);
    const id = find(reply.root, "DocumentId");
    if (code !== "0" || id === undefined)
      return { accepted: true, detail: `FaultCode ${code}` };
    const bundle = await fetch(`${origin}/bundle/${Xml.textOf(id)}`);
    const metadata = (await bundle.formData()).get("metadata") as File;
    const { title } = JSON.parse(await metadata.text()) as {
      readonly title: string;
    };
    return { accepted: true, text: title, detail: "stored" };
  });

const TOKEN = "sso-parsers";

const gatewayOptions = {
  token: TOKEN,
  accounts: [
    { account: ACCOUNT, title: ACCOUNT_TITLE, cents: 100, due: "00000000" },
  ],
  invoices: [
    {
      id: INVOICE,
      account: ACCOUNT,
      cents: 12345,
      paid: false,
      issued: "20260131T12:00:00",
      settled: "00000000T00:00:00",
      lines: [],
    },
  ],
};

const METHODS = [
  "system.listMethods",
  "report.count",
  "account.title",
  "invoice.get",
  "extract.fetch",
];

/** A scalar's text: the typed element's, or the untyped value's. */
const scalarText = (value: Xml.Element): string => {
  const [typed] = Xml.elements(value);
  return Xml.textOf(typed ?? value);
};

/**
 * What the gateway's answer to a call reads, when it carries decoded text: an unknown method name
 * from the -32601 fault, an unknown account from the 404 fault, or the title of the known account.
 */
const expectedEcho = (call: XmlRpc.MethodCall): string | undefined => {
  if (!METHODS.includes(call.methodName)) return call.methodName;
  const [account] = call.params;
  if (call.methodName !== "account.title" || account === undefined)
    return undefined;
  const text =
    typeof account === "string"
      ? account
      : "string" in account
        ? account.string
        : undefined;
  if (text === undefined) return undefined;
  return text === ACCOUNT ? ACCOUNT_TITLE : text;
};

/**
 * Send a call to `/RPC2`. The -32700 fault is its parse error; any other answer is read with the
 * independent parser for the decoded text it carries (see {@link expectedEcho}).
 */
const gatewayReads = (origin: string, document: string) =>
  Effect.promise(async (): Promise<Observed> => {
    const response = await fetch(`${origin}/RPC2?session=${TOKEN}`, {
      method: "POST",
      headers: { "content-type": "text/xml" },
      body: encoder.encode(document),
    });
    const text = await response.text();
    if (response.status !== 200)
      return { accepted: true, detail: `${response.status} ${text}` };
    const reply = independent.read(text);
    if (!reply.accepted)
      return { accepted: true, detail: `an unreadable reply: ${reply.error}` };
    const fault = find(reply.root, "fault");
    if (fault === undefined) {
      const value = find(reply.root, "value")!;
      return {
        accepted: true,
        text: scalarText(value),
        detail: "a result",
      };
    }
    const members = new Map(
      Xml.elements(find(fault, "struct")!, "member").map((member) => [
        Xml.textOf(Xml.child(member, "name")),
        scalarText(Xml.child(member, "value")),
      ]),
    );
    const code = members.get("faultCode");
    const message = members.get("faultString") ?? "";
    if (code === "-32700")
      return { accepted: false, detail: `${code} ${message}` };
    const echo =
      /^server error\. requested method ([\s\S]*) not found$/.exec(
        message,
      )?.[1] ?? /^no such account ([\s\S]*)$/.exec(message)?.[1];
    return {
      accepted: true,
      ...(echo === undefined ? {} : { text: echo }),
      detail: `fault ${code} ${message}`,
    };
  });
