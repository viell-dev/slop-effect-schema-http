import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  Actions,
  Files,
  Soap,
  WebDav,
  Wsdl,
} from "../clients/soap-store/index.js";
import * as Xml from "../formats/xml.js";
import {
  AllowList,
  EntityTag,
  UploadReceipt,
  XmlTextFromBytes,
} from "./soap-store.js";

/**
 * Round trips for every transform of the SOAP store's values and contracts. Equality is checked on
 * the application side (`decode(encode(value))`) and, for canonical wire forms, on the wire side
 * (`encode(decode(wire))`). Negative cases name looser or invalid spellings the store never sends.
 */

type Codec = Schema.Codec<unknown, unknown>;

const decode = (schema: Codec, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input);

const encode = (schema: Codec, value: unknown) =>
  Schema.encodeUnknownEffect(schema)(value);

/** `decode(encode(value))` equals `value`; returns the encoded form. */
const fromValue = (schema: Codec, value: unknown) =>
  Effect.gen(function* () {
    const encoded = yield* encode(schema, value);
    expect(yield* decode(schema, encoded)).toEqual(value);
    return encoded;
  });

/** `encode(decode(wire))` equals `wire`; returns the decoded value. */
const fromWire = (schema: Codec, wire: unknown) =>
  Effect.gen(function* () {
    const value = yield* decode(schema, wire);
    expect(yield* encode(schema, value)).toEqual(wire);
    return value;
  });

/** The message of a refused decode. */
const refused = (schema: Codec, input: unknown) =>
  Effect.map(Effect.flip(decode(schema, input)), (error) => error.message);

/** The message of a refused encode. */
const unwritable = (schema: Codec, value: unknown) =>
  Effect.map(Effect.flip(encode(schema, value)), (error) => error.message);

const latin1Bytes = (text: string): Uint8Array =>
  Uint8Array.from(text, (character) => character.charCodeAt(0));

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("soap-store values", () => {
  it.effect(
    "[PAY-4a] XmlTextFromBytes reads the encoding from the declaration and writes the same bytes back",
    () =>
      Effect.gen(function* () {
        const latin = `<?xml version="1.0" encoding="ISO-8859-1"?><t>Größe &#8364;</t>`;
        expect(yield* fromWire(XmlTextFromBytes, latin1Bytes(latin))).toBe(
          latin,
        );
        const declared = `<?xml version='1.0' encoding='utf-8'?><t>Größe €</t>`;
        expect(yield* fromWire(XmlTextFromBytes, utf8(declared))).toBe(
          declared,
        );
        // Without a declaration, XML is UTF-8.
        expect(yield* fromWire(XmlTextFromBytes, utf8("<t>€</t>"))).toBe(
          "<t>€</t>",
        );
        // A byte order mark survives as U+FEFF.
        const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("<t/>")]);
        expect(yield* fromWire(XmlTextFromBytes, bom)).toBe("﻿<t/>");
        // ISO-8859-1 is not windows-1252: 0x80 is U+0080, not the euro sign.
        const control = new Uint8Array([
          ...latin1Bytes(`<?xml version="1.0" encoding="iso-8859-1"?><t>`),
          0x80,
          ...latin1Bytes("</t>"),
        ]);
        expect(yield* fromWire(XmlTextFromBytes, control)).toContain(
          "<t>\u0080</t>",
        );
      }),
  );

  it.effect(
    "[PAY-4a] XmlTextFromBytes refuses bytes invalid in the declared encoding, other encodings, and characters ISO-8859-1 lacks",
    () =>
      Effect.gen(function* () {
        expect(
          yield* refused(XmlTextFromBytes, latin1Bytes("<t>Größe</t>")),
        ).toContain("not valid UTF-8, the encoding XML assumes");
        expect(
          yield* refused(
            XmlTextFromBytes,
            latin1Bytes(`<?xml version="1.0" encoding="utf-8"?><t>é</t>`),
          ),
        ).toContain("the encoding the declaration names");
        expect(
          yield* refused(
            XmlTextFromBytes,
            latin1Bytes(`<?xml version="1.0" encoding="windows-1252"?><t/>`),
          ),
        ).toContain("unsupported XML encoding windows-1252");
        expect(
          yield* unwritable(
            XmlTextFromBytes,
            `<?xml version="1.0" encoding="ISO-8859-1"?><t>€</t>`,
          ),
        ).toContain("U+20AC cannot be written in ISO-8859-1");
        expect(
          yield* unwritable(
            XmlTextFromBytes,
            `<?xml version="1.0" encoding="EBCDIC-037"?><t/>`,
          ),
        ).toContain("unsupported XML encoding EBCDIC-037");
      }),
  );

  it.effect(
    "[RET-3] EntityTag round-trips strong and weak tags and refuses looser spellings",
    () =>
      Effect.gen(function* () {
        expect(yield* fromWire(EntityTag, '"5f1c0e2a"')).toEqual({
          weak: false,
          opaque: "5f1c0e2a",
        });
        expect(yield* fromWire(EntityTag, 'W/"v2"')).toEqual({
          weak: true,
          opaque: "v2",
        });
        expect(yield* fromWire(EntityTag, '""')).toEqual({
          weak: false,
          opaque: "",
        });
        for (const loose of [
          "5f1c0e2a",
          'w/"v2"',
          "W/v2",
          '"a b"',
          '"a"b"',
          "'v2'",
          ' "v2"',
        ])
          expect(yield* refused(EntityTag, loose)).toContain(
            "not an entity tag",
          );
        expect(
          yield* unwritable(EntityTag, { weak: false, opaque: 'say "hi"' }),
        ).toContain("an entity tag cannot hold");
      }),
  );

  it.effect(
    "[STAT-7] AllowList round-trips method tokens case-sensitively and refuses non-tokens",
    () =>
      Effect.gen(function* () {
        expect(yield* fromWire(AllowList, "OPTIONS, PROPFIND")).toEqual([
          "OPTIONS",
          "PROPFIND",
        ]);
        expect(yield* fromWire(AllowList, "")).toEqual([]);
        expect(yield* fromValue(AllowList, ["propfind", "PROPFIND"])).toBe(
          "propfind, PROPFIND",
        );
        // Canonicalization: separators and empty elements are not kept.
        expect(yield* decode(AllowList, "GET,PUT, ,")).toEqual(["GET", "PUT"]);
        for (const loose of ["GET PUT", "GET;PUT", '"GET"'])
          expect(yield* refused(AllowList, loose)).toContain(
            "not a method token",
          );
        expect(yield* unwritable(AllowList, ["GE T"])).toContain(
          "not a method token",
        );
      }),
  );

  it.effect(
    "[PAY-7] UploadReceipt round-trips one CRLF-terminated line and refuses looser receipts",
    () =>
      Effect.gen(function* () {
        expect(
          yield* fromWire(UploadReceipt, 'STORED DOC-000005 8 "a1b2"\r\n'),
        ).toEqual({
          id: "DOC-000005",
          size: 8,
          etag: { weak: false, opaque: "a1b2" },
        });
        for (const loose of [
          'STORED DOC-000005 8 "a1b2"\n',
          'STORED DOC-000005 8 "a1b2"',
          'STORED DOC-000005 8 "a1b2"\r\nSTORED DOC-000006 1 "c"\r\n',
          'STORED DOC-000005 08 "a1b2"\r\n',
          'stored DOC-000005 8 "a1b2"\r\n',
        ])
          expect(yield* refused(UploadReceipt, loose)).toContain(
            "not a receipt line",
          );
        yield* refused(UploadReceipt, "STORED DOC-000005 8 a1b2\r\n");
      }),
  );
});

const info = (id: string, name: string) => ({
  id,
  name,
  title: `Titel ${name}`,
  contentType: "application/pdf",
  size: 3,
  etag: { weak: false, opaque: `tag-${id}` },
  modified: "2026-10-29T12:00:00Z",
});

const listResult = (inner: string) =>
  Xml.parse(
    `<ListDocumentsResponse xmlns="urn:docvault:store:2003"><ListDocumentsResult>` +
      `<FaultCode>0</FaultCode><FaultString>OK</FaultString>${inner}` +
      `</ListDocumentsResult></ListDocumentsResponse>`,
  );

const storeResult = (inner: string) =>
  Xml.parse(
    `<StoreDocumentResponse xmlns="urn:docvault:store:2003"><StoreDocumentResult>${inner}` +
      `</StoreDocumentResult></StoreDocumentResponse>`,
  );

const envelope = (body: string) =>
  utf8(
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${body}</s:Body></s:Envelope>`,
  );

const payload = (namespace: string) =>
  `<StoreDocument xmlns="${namespace}"><Name>a</Name><Title/><ContentType>text/plain</ContentType><Content>YQ==</Content></StoreDocument>`;

const fault11 = (code: string, detail = "<detail/>") =>
  Xml.parse(
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault>` +
      `<faultcode>${code}</faultcode><faultstring>x</faultstring>${detail}</soap:Fault></soap:Body></soap:Envelope>`,
  );

describe("soap-store contracts", () => {
  it.effect(
    "[PAY-3a] ListDocuments results round-trip all three list shapes and refuse the others",
    () =>
      Effect.gen(function* () {
        const output = Actions.ListDocuments.output as Codec;
        const shapes: ReadonlyArray<readonly [number, string]> = [
          [0, "<Count>0</Count></ListDocumentsResult>"],
          [1, "<Count>1</Count><Documents><Item><DocumentInfo>"],
          [2, "<Count>2</Count><Documents><DocumentInfo>"],
        ];
        for (const [size, shape] of shapes) {
          const value = {
            _tag: "Listed",
            documents: Array.from({ length: size }, (_, index) =>
              info(`DOC-00000${index + 1}`, `file-${index}.pdf`),
            ),
          };
          const element = (yield* fromValue(output, value)) as Xml.Element;
          expect(Xml.serialize(element)).toContain(shape);
          yield* fromWire(output, element);
        }
        yield* fromValue(output, {
          _tag: "Refused",
          code: 1001,
          message: "No such document",
        });
        const item = Xml.serialize(
          Xml.element(
            "DocumentInfo",
            {},
            ...[
              ["Id", "DOC-000001"],
              ["Name", "a.pdf"],
              ["Title", "A"],
              ["ContentType", "application/pdf"],
              ["Size", "3"],
              ["ETag", '"t"'],
              ["Modified", "2026-10-29T12:00:00Z"],
            ].map(([name, text]) => Xml.element(name!, {}, text!)),
          ),
        );
        for (const [loose, reason] of [
          ["<Count>0</Count><Documents/>", "an empty list omits <Documents>"],
          [
            `<Count>1</Count><Documents>${item}</Documents>`,
            "unexpected <DocumentInfo> in <Documents>",
          ],
          [
            `<Count>2</Count><Documents><Item>${item}</Item><Item>${item}</Item></Documents>`,
            "expected <DocumentInfo>",
          ],
          [
            `<Count>2</Count><Documents>${item}${item}${item}</Documents>`,
            "<Count> is 2 but 3 are listed",
          ],
          ["<Count>01</Count>", "not a non-negative integer"],
        ] as const)
          expect(yield* refused(output, listResult(loose))).toContain(reason);
      }),
  );

  it.effect(
    "[ERR-1a] action results round-trip success and refusal, and refuse a refusal carrying success fields",
    () =>
      Effect.gen(function* () {
        const output = Actions.StoreDocument.output as Codec;
        yield* fromValue(output, {
          _tag: "Stored",
          id: "DOC-000007",
          etag: { weak: false, opaque: "abc" },
        });
        yield* fromValue(output, {
          _tag: "Refused",
          code: 5003,
          message: "Storage backend unavailable",
        });
        for (const [loose, reason] of [
          [
            `<FaultCode>1002</FaultCode><FaultString>exists</FaultString><DocumentId>DOC-1</DocumentId>`,
            "unexpected <DocumentId>",
          ],
          [
            `<FaultCode>0</FaultCode><FaultString>OK</FaultString><ETag>"a"</ETag>`,
            "missing <DocumentId>",
          ],
          [
            `<FaultCode>zero</FaultCode><FaultString>OK</FaultString>`,
            "FaultCode is not an integer",
          ],
        ] as const)
          expect(yield* refused(output, storeResult(loose))).toContain(reason);
        expect(
          yield* refused(
            output,
            Xml.parse(
              `<StoreDocumentResponse xmlns="urn:example:other"><StoreDocumentResult/></StoreDocumentResponse>`,
            ),
          ),
        ).toContain("expected {urn:docvault:store:2003}StoreDocumentResponse");
        expect(
          yield* unwritable(output, { _tag: "Refused", code: 0, message: "" }),
        ).toContain("a refusal is nonzero");
      }),
  );

  it.effect(
    "[PAY-3a] SOAP 1.1 and 1.2 documents round-trip a payload and refuse the other version's envelope",
    () =>
      Effect.gen(function* () {
        const input = {
          name: "Größe.pdf",
          title: "Kosten – 5 €",
          contentType: "application/pdf",
          content: new Uint8Array([0, 1, 255]),
        };
        const soap11 = Soap.Soap11.document(
          Actions.StoreDocument.input,
        ) as Codec;
        const soap12 = Soap.Soap12.document(
          Actions.StoreDocument.input,
        ) as Codec;
        const bytes11 = yield* fromValue(soap11, input);
        const bytes12 = yield* fromValue(soap12, input);
        yield* fromWire(soap11, bytes11);
        expect(yield* refused(soap12, bytes11)).toContain(
          "expected {http://www.w3.org/2003/05/soap-envelope}Envelope",
        );
        expect(yield* refused(soap11, bytes12)).toContain(
          "expected {http://schemas.xmlsoap.org/soap/envelope/}Envelope",
        );
        // The namespace may be bound on the envelope; the payload is checked in its own scope.
        expect(
          yield* decode(
            soap11,
            utf8(
              `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:d="urn:docvault:store:2003"><s:Body><d:StoreDocument><d:Name>a</d:Name><d:Title/><d:ContentType>text/plain</d:ContentType><d:Content>YQ==</d:Content></d:StoreDocument></s:Body></s:Envelope>`,
            ),
          ),
        ).toEqual({
          name: "a",
          title: "",
          contentType: "text/plain",
          content: utf8("a"),
        });
        expect(
          yield* refused(soap11, envelope(payload("urn:example:other"))),
        ).toContain("expected {urn:docvault:store:2003}StoreDocument");
        expect(
          yield* refused(
            soap11,
            envelope(payload("urn:docvault:store:2003").repeat(2)),
          ),
        ).toContain("the SOAP Body holds 2 elements, not one");
        expect(
          yield* refused(
            soap11,
            envelope(
              payload("urn:docvault:store:2003").replace("YQ==", "Y Q=="),
            ),
          ),
        ).toBeTruthy();
      }),
  );

  it.effect(
    "[ERR-6] SOAP faults round-trip in both versions, with Client and Server read as Sender and Receiver",
    () =>
      Effect.gen(function* () {
        const faults = [
          {
            _tag: "LockConflict",
            code: "Receiver",
            message: "locked",
            heldBy: "alice",
            expires: "2026-10-29T12:01:00Z",
          },
          {
            _tag: "DocumentNotFound",
            code: "Sender",
            message: "missing",
            id: "DOC-9",
          },
          { _tag: "SoapFault", code: "Sender", message: "bad seconds" },
        ];
        for (const soap of [Soap.Soap11, Soap.Soap12])
          for (const fault of faults) {
            const element = yield* fromValue(soap.fault as Codec, fault);
            yield* fromWire(soap.fault as Codec, element);
          }
        expect(
          yield* decode(Soap.Soap11.fault as Codec, fault11("soap:Server")),
        ).toEqual({
          _tag: "SoapFault",
          code: "Receiver",
          message: "x",
        });
        // An absent detail reads like an empty one; encoding writes the empty element.
        expect(
          yield* decode(Soap.Soap11.fault as Codec, fault11("soap:Client", "")),
        ).toEqual({ _tag: "SoapFault", code: "Sender", message: "x" });
        expect(
          yield* refused(
            Soap.Soap11.fault as Codec,
            fault11("soap:MustUnderstand"),
          ),
        ).toContain("unknown fault code soap:MustUnderstand");
        expect(
          yield* refused(Soap.Soap11.fault as Codec, fault11("other:Client")),
        ).toContain("unknown fault code other:Client");
        expect(
          yield* refused(
            Soap.Soap11.fault as Codec,
            fault11(
              "soap:Client",
              `<detail><Quota xmlns="urn:docvault:store:2003"/></detail>`,
            ),
          ),
        ).toContain("expected {urn:docvault:store:2003}DocumentNotFound");
      }),
  );

  it.effect(
    "[PAY-3a] the WSDL summary and the WebDAV listing are decode-only, and their reverse says why",
    () =>
      Effect.gen(function* () {
        expect(
          yield* unwritable(Wsdl.ServiceDescriptionFromElement as Codec, {
            name: "DocVault",
            targetNamespace: "urn:docvault:store:2003",
            ports: [],
          }),
        ).toContain("cannot be written back");
        expect(yield* unwritable(WebDav.Listing as Codec, [])).toContain(
          "drops the collections",
        );
      }),
  );

  it.live(
    "[PAY-6] the upload form round-trips through FormData and refuses other parts",
    () =>
      Effect.gen(function* () {
        const input = {
          label: "Grüße",
          file: {
            name: "Grüße.pdf",
            type: "application/pdf",
            bytes: new Uint8Array([0x25, 0, 0xff]),
          },
        };
        const form = (yield* fromValue(
          Files.UploadForm as Codec,
          input,
        )) as FormData;
        expect([...form.keys()]).toEqual(["label", "file"]);
        const extra = new FormData();
        extra.append("label", "x");
        extra.append("file", new Blob(["a"]), "a.pdf");
        extra.append("comment", "y");
        expect(yield* refused(Files.UploadForm as Codec, extra)).toContain(
          "expected the parts label, file",
        );
        const labelAsFile = new FormData();
        labelAsFile.append("label", new Blob(["x"]), "label.txt");
        labelAsFile.append("file", new Blob(["a"]), "a.pdf");
        expect(
          yield* refused(Files.UploadForm as Codec, labelAsFile),
        ).toContain("label is not a text field");
        expect(
          yield* unwritable(Files.UploadForm as Codec, {
            ...input,
            label: " ",
          }),
        ).toContain("must not be blank");
      }),
  );

  it.live(
    "[PAY-6] the bundle round-trips through FormData, awaiting both parts inside the schema",
    () =>
      Effect.gen(function* () {
        const bundle = {
          metadata: {
            id: "DOC-000004",
            name: "Prüfbericht.txt",
            title: "Prüfbericht",
            contentType: "text/plain",
            size: 2,
            etag: { weak: false, opaque: "t" },
            modified: "2026-10-01T09:30:00Z",
          },
          fileName: "Prüfbericht.txt",
          contentType: "text/plain",
          content: utf8("ok"),
        };
        const form = (yield* fromValue(
          Files.BundleFromFormData as Codec,
          bundle,
        )) as FormData;
        expect((form.get("metadata") as File).name).toBe("metadata.json");
        const notJson = new FormData();
        notJson.append(
          "metadata",
          new File(["{}"], "m.txt", { type: "text/plain" }),
        );
        notJson.append("content", new File(["ok"], "a.txt"));
        expect(
          yield* refused(Files.BundleFromFormData as Codec, notJson),
        ).toContain("metadata is text/plain, not JSON");
        const inline = new FormData();
        inline.append("metadata", JSON.stringify(bundle.metadata));
        inline.append("content", new File(["ok"], "a.txt"));
        expect(
          yield* refused(Files.BundleFromFormData as Codec, inline),
        ).toContain("metadata is not a file part");
        const malformed = new FormData();
        malformed.append(
          "metadata",
          new File(
            [JSON.stringify({ ...bundle.metadata, etag: "t" })],
            "metadata.json",
            {
              type: "application/json",
            },
          ),
        );
        malformed.append("content", new File(["ok"], "a.txt"));
        expect(
          yield* refused(Files.BundleFromFormData as Codec, malformed),
        ).toContain("not an entity tag");
      }),
  );

  it.effect(
    "[RET-3] ConditionHeaders round-trips the three write conditions and refuses both validators together",
    () =>
      Effect.gen(function* () {
        const headers = WebDav.ConditionHeaders as Codec;
        expect(
          yield* fromValue(headers, {
            _tag: "Replace",
            etag: { weak: false, opaque: "v1" },
          }),
        ).toEqual({ "if-match": '"v1"' });
        expect(yield* fromValue(headers, { _tag: "Create" })).toEqual({
          "if-none-match": "*",
        });
        expect(yield* fromValue(headers, { _tag: "Unconditional" })).toEqual(
          {},
        );
        expect(
          yield* refused(headers, { "if-match": '"v1"', "if-none-match": "*" }),
        ).toContain("not a write condition this client sends");
        expect(yield* refused(headers, { "if-none-match": '"v1"' })).toContain(
          "not a write condition this client sends",
        );
        yield* refused(headers, { "if-match": "v1" });
      }),
  );
});
