import { describe, expect, it } from "@effect/vitest";
import { Cause, DateTime, Exit, Schema } from "effect";
import * as Portal from "./portal.js";
import * as Services from "./services.js";

/** Round trips of the portal facade's conventions and the gateway download's headers (APP-2). */

const refusal = <S extends Schema.Top>(schema: S, input: unknown): string => {
  const exit = Schema.decodeUnknownExit(schema as never)(input);
  expect(Exit.isFailure(exit)).toBe(true);
  return Exit.isFailure(exit)
    ? (Cause.squash(exit.cause) as Error).message
    : "";
};

describe("flows: the portal facade's conventions (APP-2)", () => {
  it("[APP-2] bytes travel as an array of numbers from 0 to 255, and nothing looser", () => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 254, 255]);
    const numbers = Schema.encodeSync(Portal.ByteArray)(bytes);
    expect(numbers).toEqual([0, 1, 127, 128, 254, 255]);
    expect(Schema.decodeSync(Portal.ByteArray)(numbers)).toEqual(bytes);
    expect(Schema.decodeSync(Portal.ByteArray)([])).toEqual(new Uint8Array());
    for (const input of [[256], [-1], [1.5], ["1"], "AAEC", [null]])
      expect(refusal(Portal.ByteArray, input)).not.toBe("");
  });

  it("[APP-2] the wrapped body uses the data contract's member names", () => {
    const document: Portal.Publication = {
      name: "notes.txt",
      title: "",
      contentType: "text/plain",
      content: Uint8Array.from([104, 105]),
    };
    const wire = Schema.encodeSync(Portal.PublishBody)({ document });
    expect(wire).toEqual({
      document: {
        Name: "notes.txt",
        Title: "",
        ContentType: "text/plain",
        Content: [104, 105],
      },
    });
    expect(Schema.decodeSync(Portal.PublishBody)(wire)).toEqual({ document });
    expect(
      refusal(Portal.PublishBody, { document: { ...wire.document, Name: "" } }),
    ).not.toBe("");
    expect(refusal(Portal.PublishBody, wire.document)).not.toBe("");
  });

  it("[APP-2] the d wrapper and its type hint are checked, not ignored", () => {
    const wire = {
      d: {
        __type: "PublishResult:#DocVault.Portal" as const,
        DocumentId: "DOC-000002",
        ETag: '"5f1c0e2a7d3b4c19"',
        Name: "portal.notes.txt",
      },
    };
    const published = Schema.decodeSync(Portal.Published)(wire);
    expect(published).toEqual({
      _tag: "Published",
      id: "DOC-000002",
      etag: { weak: false, opaque: "5f1c0e2a7d3b4c19" },
      name: "portal.notes.txt",
    });
    expect(Schema.encodeSync(Portal.Published)(published)).toEqual(wire);
    expect(refusal(Portal.Published, wire.d)).not.toBe("");
    expect(
      refusal(Portal.Published, {
        d: { ...wire.d, __type: "StoreResult:#DocVault.Portal" },
      }),
    ).not.toBe("");
    expect(
      refusal(Portal.Published, { d: { ...wire.d, ETag: "5f1c0e2a7d3b4c19" } }),
    ).toContain("not an entity tag");
  });

  it("[APP-2] a jsonerror body is a relayed store fault or another service fault", () => {
    const relayed = {
      ExceptionDetail: null,
      ExceptionType: "DocVault.Portal.StoreFaultException",
      Message: "DocVault 1002: A document named portal.x already exists",
      StackTrace: null,
    };
    const fault = Schema.decodeSync(Portal.Fault)(relayed);
    expect(fault).toEqual({
      _tag: "StoreFault",
      code: 1002,
      message: "A document named portal.x already exists",
    });
    expect(Schema.encodeSync(Portal.Fault)(fault)).toEqual(relayed);
    const other = {
      ExceptionDetail: null,
      ExceptionType: "System.ServiceModel.ProtocolException",
      Message: "The content type of the response message does not match",
      StackTrace: null,
    };
    expect(
      Schema.encodeSync(Portal.Fault)(Schema.decodeSync(Portal.Fault)(other)),
    ).toEqual(other);
    expect(
      refusal(Portal.Fault, {
        ...relayed,
        Message: "Storage backend unavailable",
      }),
    ).toContain("a relayed store fault reads");
    expect(
      refusal(Portal.Fault, { ...relayed, StackTrace: "at ..." }),
    ).not.toBe("");
  });

  it("[APP-2] the Request Error page is read one way, for its exception message", () => {
    const page =
      "<html><body><p>The server encountered an error processing the request. The exception message is " +
      "'Member &#39;Content&#39; is required.'. See server logs for more details.</p></body></html>";
    expect(Schema.decodeSync(Portal.RequestErrorPage)(page)).toBe(
      "Member 'Content' is required.",
    );
    expect(
      refusal(Portal.RequestErrorPage, "<html>Bad Request</html>"),
    ).toContain("not a WCF Request Error page");
    const exit = Schema.encodeExit(Portal.RequestErrorPage)("anything");
    expect(Exit.isFailure(exit)).toBe(true);
    expect(
      Exit.isFailure(exit) && (Cause.squash(exit.cause) as Error).message,
    ).toContain("one-way");
  });

  it("[APP-2] the download's file facts round-trip through its header schema", () => {
    const headers = {
      "content-disposition": 'attachment; filename="ME202610.DAT"',
      "last-modified": "Sun, 01 Nov 2026 02:15:00 GMT",
      "content-length": "448",
    };
    const facts = Schema.decodeSync(Services.DownloadHeaders)(headers);
    expect(facts).toEqual({
      "content-disposition": "ME202610.DAT",
      "last-modified": DateTime.makeUnsafe(Date.UTC(2026, 10, 1, 2, 15)),
      "content-length": 448,
    });
    expect(Schema.encodeSync(Services.DownloadHeaders)(facts)).toEqual(headers);
    for (const disposition of [
      "attachment; filename=ME202610.DAT",
      'inline; filename="ME202610.DAT"',
      'attachment; filename="report.csv"',
    ])
      expect(
        refusal(Services.DownloadHeaders, {
          ...headers,
          "content-disposition": disposition,
        }),
      ).not.toBe("");
  });
});
