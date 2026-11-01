# German accounts CSV reference

[german-accounts.csv](./german-accounts.csv) is a hand-authored reference for the contract in
[the gateway service page](../../services/gateway.md#reports), including its
[German import rules](../../services/gateway.md#the-german-import-2012). It is UTF-8 with a BOM,
uses semicolons, and has CRLF record endings and a final CRLF. It was not saved by Excel.

## Setup and semantic rows

Use these exact JSON options with `lane.backend("gateway", options)`:

```json
{
  "token": "german-csv-golden",
  "accounts": [
    {
      "account": "00123456",
      "title": "Café Müller",
      "cents": 0,
      "due": "00000000"
    },
    {
      "account": "12345678",
      "title": "Büro; \"Süd\"",
      "cents": 123456,
      "due": "20261231"
    },
    {
      "account": "87654321",
      "title": "Köln\r\nZweite Zeile",
      "cents": -705,
      "due": "20261130"
    },
    { "account": "00000009", "title": "Straße", "cents": 9, "due": "20270228" }
  ]
}
```

The JSON strings are the semantic values: the third title contains an actual CRLF, account numbers
retain leading zeroes, and `00000000` means no due date. The other three dates are valid calendar
dates. All data is synthetic.

`GET /cgi-bin/report.cgi?session=german-csv-golden&report=accounts&format=csv&locale=de_DE`
selects the German export (`application/octet-stream`, attachment `konten.csv`). The fixture chooses
the account-array order shown above; the service page does not promise a general sorting rule.
Posting these bytes to
`/cgi-bin/import.cgi?session=german-csv-golden&locale=de_DE` should replace the account table with
these four semantic rows and answer `OK|4\n` (a bare LF in the pipe reply).

The money conversions can be checked without floating-point arithmetic:

| Account    |  Cents | CSV amount | Manual conversion          |
| ---------- | -----: | ---------- | -------------------------- |
| `00123456` |      0 | `0,00`     | `0 × 100 + 0 = 0`          |
| `12345678` | 123456 | `1234,56`  | `1234 × 100 + 56 = 123456` |
| `87654321` |   -705 | `-7,05`    | `−(7 × 100 + 5) = −705`    |
| `00000009` |      9 | `0,09`     | `0 × 100 + 9 = 9`          |

## Literal construction

Run this PowerShell from the repository root to reproduce the file. Each CSV field and quote is
typed literally; the code only joins the stated CRLFs, encodes UTF-8, and prepends the BOM. It does
not serialize semantic rows or implement CSV parsing or writing.

```powershell
$csvLiteral = 'Konto;Bezeichnung;Betrag;Fällig' + "`r`n" +
    '00123456;Café Müller;0,00;00000000' + "`r`n" +
    '12345678;"Büro; ""Süd""";1234,56;20261231' + "`r`n" +
    '87654321;"Köln' + "`r`n" + 'Zweite Zeile";-7,05;20261130' + "`r`n" +
    '00000009;Straße;0,09;20270228' + "`r`n"
$csvEncoding = [Text.UTF8Encoding]::new($true, $true)
$csvBytes = [byte[]]($csvEncoding.GetPreamble() + $csvEncoding.GetBytes($csvLiteral))
[IO.File]::WriteAllBytes(
    (Join-Path (Get-Location) 'fixtures/gateway/german-accounts.csv'),
    $csvBytes
)
```

Only the second and third titles need quotes: the second contains the delimiter and quotes, and
the third contains a line break. The two quotes around `Süd` each become `""`. The service permits
quoted line breaks. This fixture chooses CRLF inside the title as well as between records;
quoted CR and LF are also field data, independently of the CRLF record-separator rule
([#60](https://github.com/viell-dev/slop-effect-schema-http/issues/60)). The header and other fields
need no quotes.

## Byte evidence and provenance

Checked the saved file using PowerShell/.NET direct byte assertions and strict UTF-8 decoding,
without a CSV reader or writer. All offsets below are zero-based and include the BOM.

- Length: **199 bytes**. Prefix: `EF BB BF`; the header occupies bytes 3–34.
- CRLF pairs start at offsets **35, 73, 118, 135, 165, 197**. There are no bare CRs or LFs.
  The pair at 135 is inside the third title; the others terminate the header and four records.
  The final bytes, 197–198, are `0D 0A`.
- Quote bytes (`22`) occur at **84, 92, 93, 98, 99, 100, 129, 149**. Bytes 92–93 and 98–99
  are the doubled inner quotes. Byte 90 is the semicolon inside the second title; the file holds
  16 semicolon bytes, including that quoted one.
- UTF-8 witnesses: header `ä` at 29–30 is `C3 A4`; `é` at 49–50 is `C3 A9`; `ü` at 53–54 is
  `C3 BC`; `ö` at 131–132 is `C3 B6`; `ß` at 180–181 is `C3 9F`.

SHA-256 of the complete CSV, including its BOM and final CRLF:

```text
43398132edf2a05c036ad544ee3c81b05e77cfbb0e2805457647e525448a6224
```

Authored on 2026-11-01 in an independent fixture-author context. Technical requirements came only
from the current `services/gateway.md`; README and agent instructions supplied workflow guidance.
No backend, client, format helper, scenario, conformance test, recording, library implementation,
Git history, earlier prototype, or previous German CSV reference was inspected or run. No Excel
session or regional/application settings were used or changed. After completing the CSV, its byte
checks, and the first complete draft of this note, a final workflow-guidance check opened the
adjacent `fixtures/gateway/README.md` and encountered its month-end reference. That material did
not inform this CSV's rows, literal construction, or byte expectations.

The lead later clarified the record-separator explanation above under #60. The CSV bytes, semantic
rows, literal construction and hash remain the reference author's original values.

This is a contract reference for these four rows, not evidence of an actual Excel save or a full
CSV interoperability survey. Its independence rests on the literal construction and manual
interpretation of the service page; the byte checks establish the saved representation, not a
second implementation of the CSV contract.
