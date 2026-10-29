/**
 * The gateway's XML-RPC methods. Every call is a POST of a `text/xml` methodCall, and every answer
 * that reached the dispatcher is HTTP 200, so a fault is a body-level outcome: each method's result
 * is an `Outcome` union of the decoded value and the fault (ERR-1b). Values are decoded from the
 * lexical tree by the gateway's value conventions (PAY-3b, VAL-1c, VAL-2b, VAL-3b).
 */
import { Effect, Schema } from "effect";
import { HttpBody } from "effect/http";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import * as XmlRpc from "../../formats/xmlrpc.js";
import {
  BooleanFromBit,
  CentsFromUnits,
  DateTimeFromXmlRpc,
  OptionalDateTimeFromXmlRpc,
} from "../../values/gateway.js";
import { MonthEndExtract } from "./extract.js";
import { AccountNumber, Period } from "./pipe.js";

/** A methodCall body for `method`, its parameters encoded by `params`. The codec sets `text/xml`. */
export const call = <P, RE>(
  method: string,
  params: Schema.Codec<P, ReadonlyArray<XmlRpc.Value>, unknown, RE>,
) =>
  Body.encoder((value: P) =>
    Effect.map(Schema.encodeEffect(params)(value), (encoded) =>
      HttpBody.text(
        XmlRpc.serializeCall({ methodName: method, params: encoded }),
        "text/xml",
      ),
    ),
  );

/** A methodResponse decoded into the method's outcome. */
export const answer = <A, RD>(
  result: Schema.Codec<A, XmlRpc.Value, RD, unknown>,
) =>
  Body.decoder((response) => Body.text.decode(response), "text/xml").pipe(
    Body.schema(
      XmlRpc.ResponseText.pipe(Schema.decodeTo(XmlRpc.outcome(result))),
    ),
  );

const RpcQuery = Schema.Struct({ session: Schema.String });

/** One XML-RPC method as an operation taking the session and the parameters. */
export const method =
  <P, RE, A, RD>(
    name: string,
    params: Schema.Codec<P, ReadonlyArray<XmlRpc.Value>, unknown, RE>,
    result: Schema.Codec<A, XmlRpc.Value, RD, unknown>,
  ) =>
  (origin: string) =>
    Operation.make(
      Request.post("RPC2").pipe(
        Request.query(RpcQuery),
        Request.body(call(name, params)),
        Request.mapInput(
          (input: { readonly session: string; readonly params: P }) => ({
            query: { session: input.session },
            body: input.params,
          }),
        ),
        Request.baseUrl(origin),
      ),
      Response.status(200, answer(result)),
    );

const Money = XmlRpc.DoubleText.pipe(Schema.decodeTo(CentsFromUnits));

export const Invoice = XmlRpc.struct({
  id: XmlRpc.I4,
  account: XmlRpc.Text.pipe(Schema.decodeTo(AccountNumber)),
  amount: Money,
  paid: XmlRpc.BooleanText.pipe(Schema.decodeTo(BooleanFromBit)),
  issued: XmlRpc.DateTimeText.pipe(Schema.decodeTo(DateTimeFromXmlRpc)),
  settled: XmlRpc.DateTimeText.pipe(
    Schema.decodeTo(OptionalDateTimeFromXmlRpc),
  ),
  lines: XmlRpc.array(XmlRpc.struct({ text: XmlRpc.Text, amount: Money })),
});

const PeriodParam = XmlRpc.Text.pipe(Schema.decodeTo(Period));

export const listMethods = method(
  "system.listMethods",
  Schema.Tuple([]),
  XmlRpc.array(XmlRpc.Text),
);

/** A bare `<i4>` scalar. */
export const reportCount = method(
  "report.count",
  Schema.Tuple([PeriodParam]),
  XmlRpc.I4,
);

/** An untyped `<value>` scalar, which the specification reads as a string. */
export const accountTitle = method(
  "account.title",
  Schema.Tuple([XmlRpc.Text.pipe(Schema.decodeTo(AccountNumber))]),
  XmlRpc.Untyped,
);

export const invoice = method(
  "invoice.get",
  Schema.Tuple([XmlRpc.I4]),
  Invoice,
);

/** PAY-8: base64 of the extract's Latin-1 bytes, decoded by the same schema as the HTTP download. */
export const extractFetch = method(
  "extract.fetch",
  Schema.Tuple([PeriodParam]),
  XmlRpc.Base64.pipe(Schema.decodeTo(MonthEndExtract)),
);
