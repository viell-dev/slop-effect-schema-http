/**
 * Login and the balance report. The gateway's login is a GET with the password in the query string,
 * and the session it returns travels as a `session` query parameter on every later request. Nothing
 * about that is fixable from the client, so the contract declares it as it is (AUTH-2): the password
 * is an ordinary query field, percent-encoded by the library like any other value.
 */
import { Effect, Schema, SchemaTransformation } from "effect";
import { Body, Operation, Request, Response } from "viell-effect-schema-http";
import {
  CentsFromImpliedInteger,
  OptionalDateFromBare,
} from "../../values/gateway.js";
import { AccountNumber, pipeBody } from "./pipe.js";

const SessionFields = Schema.Tuple([
  Schema.Literal("OK"),
  Schema.NonEmptyString,
]);

/** `OK|<session>`. */
export const SessionLine = SessionFields.pipe(
  Schema.decodeTo(
    Schema.TaggedStruct("Session", { session: Schema.String }),
    SchemaTransformation.transform<
      { readonly _tag: "Session"; readonly session: string },
      (typeof SessionFields)["Type"]
    >({
      decode: ([, session]) => ({ _tag: "Session", session }),
      encode: ({ session }) => ["OK", session],
    }),
  ),
);

/** The login form's fields, sent as they are. A blank user never leaves the client. */
export const LoginQuery = Schema.Struct({
  user: Schema.NonEmptyString,
  passwd: Schema.String,
});

export const loginRequest = Request.get("cgi-bin/login.cgi").pipe(
  Request.query(LoginQuery),
  Request.mapInput(
    (input: { readonly user: string; readonly password: string }) => ({
      query: { user: input.user, passwd: input.password },
    }),
  ),
);

export const login = (origin: string) =>
  Operation.make(
    loginRequest.pipe(Request.baseUrl(origin)),
    Response.status(200, pipeBody(SessionLine)),
  );

const BalanceFields = Schema.Tuple([
  Schema.Literal("OK"),
  AccountNumber,
  CentsFromImpliedInteger,
  OptionalDateFromBare,
]);

const Balance = Schema.TaggedStruct("Balance", {
  account: Schema.String,
  balance: Schema.toType(CentsFromImpliedInteger),
  due: Schema.toType(OptionalDateFromBare),
});
export type Balance = typeof Balance.Type;

/** `OK|<account>|<cents>|<due>`, the amount as unpadded cents and the date possibly zero. */
export const BalanceLine = BalanceFields.pipe(
  Schema.decodeTo(
    Balance,
    SchemaTransformation.transform<Balance, (typeof BalanceFields)["Type"]>({
      decode: ([, account, balance, due]) => ({
        _tag: "Balance",
        account,
        balance,
        due,
      }),
      encode: ({ account, balance, due }) => ["OK", account, balance, due],
    }),
  ),
);

export const BalanceQuery = Schema.Struct({
  session: Schema.String,
  report: Schema.Literal("balance"),
  account: AccountNumber,
});

export interface BalanceInput {
  readonly session: string;
  readonly account: string;
}

const toBalanceQuery = (input: BalanceInput) => ({
  query: {
    session: input.session,
    report: "balance" as const,
    account: input.account,
  },
});

export const balanceRequest = Request.get("cgi-bin/report.cgi").pipe(
  Request.query(BalanceQuery),
  Request.mapInput(toBalanceQuery),
);

export const balanceBody = pipeBody(BalanceLine);

export const balance = (origin: string) =>
  Operation.make(
    balanceRequest.pipe(Request.baseUrl(origin)),
    Response.status(200, balanceBody),
  );

/** The location a permanent redirect names, from the headers alone; the HTML body is drained. */
export const Moved = Body.decoder((response) =>
  Effect.andThen(
    Body.empty.decode(response),
    Schema.decodeUnknownEffect(Schema.Struct({ location: Schema.String }))(
      response.headers,
    ),
  ),
);

/**
 * The 1998 desktop client's compiled-in path, `rpt.exe`, which Apache answers with a 301 to
 * `report.cgi` (STAT-10). The contract declares both the 301 and the report; whether the 301 is
 * ever seen depends on the transport's redirect handling, not on the library.
 */
export const legacyBalance = (origin: string) =>
  Operation.make(
    Request.get("cgi-bin/rpt.exe").pipe(
      Request.query(BalanceQuery),
      Request.mapInput(toBalanceQuery),
      Request.baseUrl(origin),
    ),
    Response.status(301, Response.tag("Moved", Moved)).pipe(
      Response.orElse(
        Response.status(200, Response.tag("Report", balanceBody)),
      ),
    ),
  );
