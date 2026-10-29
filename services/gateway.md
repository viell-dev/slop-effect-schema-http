# The CGI reporting gateway (`gateway`)

Apache 1.3 in front of Perl CGI scripts from 1998 onwards, a Frontier XML-RPC endpoint, and a
download directory fed by the mainframe's month-end job. Nobody owns the whole of it any more; each
convention below belongs to a team that has since moved on, and each has a downstream consumer that
would break if it changed. The [test options](#test-options) at the end are for the suite's tests,
not part of the published service.

## Endpoints

| Method and path                       | What it does                                        | Replies             |
| ------------------------------------- | --------------------------------------------------- | ------------------- |
| `GET /cgi-bin/login.cgi`              | log in, for a session                               | pipe line           |
| `GET /cgi-bin/report.cgi`             | an account's balance, or the accounts export as CSV | pipe line or CSV    |
| `GET` and `HEAD /cgi-bin/extract.cgi` | the month-end extract                               | fixed-width file    |
| `POST /cgi-bin/import.cgi`            | upload the German accounts sheet                    | pipe line           |
| any method, `/cgi-bin/rpt.exe`        | the 1998 desktop client's old path                  | 301 to `report.cgi` |
| `POST /RPC2`                          | XML-RPC                                             | XML-RPC             |
| `GET /admin/audit.cgi`                | the auditors' extract totals, behind HTTP Digest    | pipe line           |

Any other path answers 404, and another method on a listed path answers 405 with `Allow`.

## Shared conventions

- **Query strings (CGI.pm, 1995).** Every script parses its query with CGI.pm, which splits on `&`
  and also on `;`, turns `+` into a space and percent-decodes the rest. A raw `+` or `;` in a value
  therefore changes it; only a client that percent-encodes them gets its value through intact. The
  first value of a repeated name wins, and a name without `=` has an empty value.
- **Pipe replies (1998).** The Perl scripts answer every outcome with HTTP 200 and `text/plain`:
  `OK|…` on success and `ERROR|<code>|<message>` otherwise, each line ending in a bare `\n`.
  Monitoring only ever checked that the CGI did not crash, so a status other than 200 would page the
  night operator; no script has been allowed to change since. The month-end extract, which the
  mainframe team wrote, is the exception.
- **Apache's pages.** Redirects and refusals that Apache itself writes are Apache 1.3's HTML error
  pages, `text/html; charset=iso-8859-1`, signed `Apache/1.3.41 Server`.
- **Sessions.** `login.cgi` issues sessions, which the other scripts and `/RPC2` take as the
  `session` query parameter. The 2009 SSO bridge mints opaque tokens that every endpoint taking
  `session` accepts as a session value too: the query-parameter form of the token other services
  take as a header. A request without `session` is treated like an unknown session.
- **Values.** Accounts are eight digits. Amounts are cents, written differently by each part:
  unpadded in pipe replies, zero-padded with implied decimals in the extract, as units with two
  decimals in XML-RPC and the CSV export, with a decimal comma in the German variant. Dates are
  `YYYYMMDD`, with `00000000` for none.

## Logging in (1998)

`GET /cgi-bin/login.cgi?user=<name>&passwd=<password>` puts the password in the query string,
because the 1998 login page used a GET form. It answers `OK|<session>`, or `ERROR|E_AUTH|…` for a
wrong user or password and `ERROR|E_PARAM|…` when `user` or `passwd` is missing or `user` is blank.

## Reports

`GET /cgi-bin/report.cgi?session=…&report=…` serves two reports. An unknown or expired session is
`ERROR|E_SESSION|session expired or unknown`, and an unknown report `ERROR|E_PARAM|…`.

- **`report=balance&account=<account>`** answers `OK|<account>|<cents>|<due>`, the amount as
  unpadded cents and the date as `YYYYMMDD` or `00000000`. A missing account is `E_PARAM` and an
  unknown one `E_NOACCT`.
- **`report=accounts&format=csv[&locale=de_DE]`** answers the accounts export, served as
  `application/octet-stream` with `Content-Disposition: attachment`, because the 2012 script copied
  the extract download's headers. A session or parameter error is still a `text/plain` ERROR line
  in 200; `format=csv` is required.

The accounts export was added in 2012 for spreadsheet users. Both variants start with a UTF-8
byte-order mark, because Excel otherwise reads UTF-8 as windows-1252, and have a header row and one
row per account:

| Variant                    | File name      | Delimiter | Line end | Header                            | Amount    |
| -------------------------- | -------------- | --------- | -------- | --------------------------------- | --------- |
| default                    | `accounts.csv` | `,`       | LF       | `account,title,amount,due`        | `1234.56` |
| `locale=de_DE` (Frankfurt) | `konten.csv`   | `;`       | CRLF     | `Konto;Bezeichnung;Betrag;Fällig` | `1234,56` |

The German variant was added for the Frankfurt office, because that is what German Excel writes and
reads back. A value is quoted only when it holds a `"`, a line break or the delimiter, with quotes
doubled inside. Negative amounts start with `-`.

## The old desktop path (1998)

`/cgi-bin/rpt.exe` is the compiled-in path of the 1998 Windows desktop client, kept alive as an
Apache `Redirect permanent` to `/cgi-bin/report.cgi` with the same query. Apache writes the
`Location` absolute, and the 301 carries its HTML page.

## The month-end extract (2001)

`GET /cgi-bin/extract.cgi?session=<session>&period=<YYYYMM>` answers 200 `application/octet-stream`
with the period's extract file, `Content-Disposition: attachment; filename="ME<period>.DAT"`,
`Content-Length`, `Last-Modified`, and two headers that summarize the trailer: `X-Record-Count` and
`X-Control-Total` (13 digits, cents with implied decimals). `HEAD` answers the same headers without
the body.

The mainframe team wrote `extract.cgi` in 2001. Unlike the Perl scripts, it refuses with real
statuses, each with an `ERROR|<code>|<message>` text body: an unknown or expired session is 403
`E_SESSION`, a malformed period 400 `E_PARAM`, and a period without an extract 404 `E_NOPERIOD`.

The file is a byte copy of the mainframe's `RECFM=FB, LRECL=64` file: ISO-8859-1, no field
delimiters and no record separators, amounts as unsigned zero-padded cents with two implied
decimals, and dates as `YYYYMMDD` with `00000000` for none. A header record opens it and a trailer
carrying the record count and control total closes it. The mainframe team own the layout, and the
general ledger reconciles against it, so it cannot change. Every record is 64 bytes:

| Record  | Bytes | Field                                         |
| ------- | ----- | --------------------------------------------- |
| header  | 1     | `H`                                           |
|         | 2–9   | `MONTHEND`                                    |
|         | 10–15 | the period, `YYYYMM`                          |
|         | 16–23 | the run date, `YYYYMMDD`                      |
|         | 24–64 | spaces                                        |
| detail  | 1     | `D`                                           |
|         | 2–9   | the account                                   |
|         | 10–39 | the title, padded with spaces                 |
|         | 40–50 | the amount, 11 digits of cents                |
|         | 51–58 | the due date, `YYYYMMDD` or `00000000`        |
|         | 59    | the status: `O` open, `P` paid, `X` cancelled |
|         | 60–64 | spaces                                        |
| trailer | 1     | `T`                                           |
|         | 2–7   | the record count, 6 digits                    |
|         | 8–20  | the control total, 13 digits of cents         |
|         | 21–64 | spaces                                        |

The trailer is printed as the job wrote it. A re-run whose trailer was patched by hand can disagree
with the detail records, and the headers and the audit totals then report the trailer.

## The German import (2012)

`POST /cgi-bin/import.cgi?session=…&locale=de_DE` is the Frankfurt office's upload of the German
accounts sheet. It replaces the accounts table and answers `OK|<rows>`, or
`ERROR|E_FORMAT|<reason>`; only `locale=de_DE` is supported. The validator refuses anything German
Excel would not have produced:

- a missing byte-order mark, or bytes that are not UTF-8;
- a line break other than CRLF, or a file that does not end with CRLF;
- a header other than `Konto;Bezeichnung;Betrag;Fällig`;
- a row without exactly four fields, a `Konto` that is not eight digits, a `Betrag` without a
  decimal comma and two decimals, or a `Fällig` that is not eight digits.

The reason names the line, such as `line 3: Betrag needs a decimal comma`. Fields may be quoted
with `"`, with a quote doubled inside.

## XML-RPC (1999)

`POST /RPC2?session=…` is the XML-RPC endpoint the desktop reporting client has called since 1999,
first served by Frontier::RPC and later by XMLRPC::Lite. Like every XML-RPC server of its age it
answers HTTP 200 for every call that reached the dispatcher, faults included, as `text/xml` with
`Server: Frontier/5.1.2-WinNT`. Only a request that is not `text/xml` at all is refused by the HTTP
layer, with Apache's 400 page.

| Method               | Parameters         | Result                                                        |
| -------------------- | ------------------ | ------------------------------------------------------------- |
| `system.listMethods` | none               | an array of the five method names                             |
| `report.count`       | `<string>` period  | `<i4>`: the number of detail records in the period's extract  |
| `account.title`      | `<string>` account | the title as a bare `<value>` without a type element          |
| `invoice.get`        | `<i4>` invoice id  | a `<struct>`, below                                           |
| `extract.fetch`      | `<string>` period  | `<base64>`: the extract file, the same bytes as `extract.cgi` |

The 1999 `account.title` handler returns the bare scalar without a type element. A parameter
without a type element counts as a string, and `<int>` as `<i4>`. An invoice is a struct of `id`
(`<i4>`), `account` (`<string>`), `amount` (`<double>`), `paid` (`<boolean>`), `issued` and
`settled` (`<dateTime.iso8601>`), and `lines`, an array of structs of `text` and `amount`. Dates are
as stored: invoices migrated from 1998 may hold impossible dates, and an unpaid invoice is settled
`00000000T00:00:00`.

### Values

Values are written the way Perl wrote them: `<i4>`, doubles with exactly two decimals, `<boolean>`
as `1` or `0`, `dateTime.iso8601` without separators in the date or a zone (`YYYYMMDDTHH:MM:SS`),
`00000000T00:00:00` for "no date", untyped `<value>` strings where the original handlers forgot the
type, and base64 wrapped by MIME::Base64 at 76 columns with a newline after every line.

### Faults

Faults follow the 2001 interoperability list for protocol errors, and use HTTP-like numbers for
application errors because the 2003 maintainers liked them:

| `faultCode` | `faultString`                                                                  | When                                   |
| ----------- | ------------------------------------------------------------------------------ | -------------------------------------- |
| `-32700`    | `parse error. not well formed`                                                 | the call is not well-formed XML        |
| `-32601`    | `server error. requested method <name> not found`                              | an unknown method                      |
| `-32602`    | `server error. invalid method parameters`                                      | the wrong number or type of parameters |
| `-32603`    | `server error. internal xml-rpc error`                                         | a reply value XML cannot carry         |
| `401`       | `session expired or unknown`                                                   | an unknown or expired session          |
| `404`       | `no extract for <period>`, `no such account <account>`, `no such invoice <id>` | nothing found                          |

### XML rules

Both servers parsed with expat, so a call is read as expat reads it. Line ends are normalized to LF
first, and a character outside XML 1.0's
[`Char` production](https://www.w3.org/TR/xml/#charsets), raw or as a character reference, or an
`&` that starts no reference, makes the document malformed; so do bytes that are not UTF-8, and a
hexadecimal reference spelt with an upper-case `&#X`, since XML allows only the lower-case `x`.
XML-RPC defines no attributes, so their values are ignored, but a malformed one still makes the
document malformed: each must be quoted, hold no `<`, and use only valid references. A malformed
call is answered with the -32700 parse-error fault before the session or the method is looked at.
The writer escapes text, writes a carriage return as `&#13;` so a reader's line-end handling keeps
it, and never writes a character outside `Char`: a stored value that holds one turns the reply into
the -32603 internal-error fault.

## The audit endpoint (1997 Digest)

`/admin` sits behind Apache 1.3's original mod_digest, which implements RFC 2069 (1997): no `qop`,
no `nc`, no `cnonce`, and

```text
response = MD5(MD5(user:realm:password):nonce:MD5(method:uri))
```

The auditors' 1999 audit tool only speaks that form, and the security team, unable to replace the
tool, made every nonce single-use instead of turning the module off. So each nonce authorizes one
request: reusing it is answered with a fresh challenge carrying `stale=true`, and every audit call
costs two round trips. A nonce is spent as soon as a request arrives with it, before the reply is
written, so a request the client abandons has still spent its nonce, and so has a request whose
response was wrong.

A request without valid credentials answers 401 with Apache's "Authorization Required" page and a
challenge:

```http
WWW-Authenticate: Digest realm="Reporting Gateway", nonce="<nonce>", opaque="<opaque>", algorithm=MD5
```

The realm is written between quotes as configured, without escaping, as mod_digest wrote its
`AuthName`; a realm containing `"` or `\` would produce a malformed challenge. The nonce is base64
and the opaque value hex, so neither contains those characters.

The `Authorization` header must carry `username`, `realm`, `nonce`, `uri`, `response` and the
challenge's `opaque`. A missing directive answers Apache's 400 page, and so does a `uri` that
differs from the request line's target: mod_digest compares them byte for byte. A wrong realm,
opaque value, nonce or response is answered with a fresh challenge.

`GET /admin/audit.cgi?period=<YYYYMM>` answers `OK|<period>|<count>|<cents>` with the extract's
trailer totals, or `ERROR|E_NOPERIOD|…` in 200.

## Test options

Start the gateway with `lane.backend("gateway", options)`. Every start has fresh state: sessions,
Digest nonces and the accounts table. Options are plain JSON, and every member is optional.

- `users`: `login.cgi` users, as name to password.
- `token`: the SSO bridge's token, accepted as a `session` value everywhere.
- `realm`: the Digest realm of `/admin`. Defaults to `Reporting Gateway`. It is written unescaped,
  so keep it free of `"` and `\`.
- `auditors`: the Digest users of `/admin`, as name to password.
- `accounts`: the initial accounts table, as `{ account, title, cents, due }`, with an eight-digit
  account and a due date of `YYYYMMDD` or `00000000`.
- `extracts`: month-end extracts by period (`YYYYMM`), each `{ runDate, lastModified, records,
trailer? }`. `runDate` is `YYYYMMDD`; `lastModified` is an ISO 8601 instant, served as
  `Last-Modified`; `records` are `{ account, title, cents, due, status }`, with `status` `O`, `P` or
  `X`; `trailer`, `{ count, cents }`, is the trailer as printed when it was patched by hand, and
  defaults to the true count and total. Values must fit their fields and be printable ISO-8859-1.
- `invoices`: `{ id, account, cents, paid, issued, settled, lines }`, with `issued` and `settled` as
  stored (`YYYYMMDDTHH:MM:SS`) and `lines` as `{ text, cents }`.
- `delays`: replies to hold, to test timeouts and interruption, as
  `{ path, milliseconds, authorized?, times? }`. A delay applies to requests for `path`, only to
  those that do (`authorized: true`) or do not (`false`) carry `Authorization` when given, and only
  to the first `times` matching requests when given. The reply, and any state it changes such as a
  spent nonce, is settled when the request arrives; only the answer waits, and the wait ends early
  when the client goes away.
