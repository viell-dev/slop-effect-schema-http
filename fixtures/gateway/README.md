# Hand-authored month-end extract

[month-end.DAT](./month-end.DAT) is an independent, synthetic contract referee for the 64-byte
month-end layout in the
[gateway service page](../../services/gateway.md#the-month-end-extract-2001).
It is 384 ISO-8859-1 bytes: one header, four details and one trailer, concatenated without a BOM,
record separators or a final newline. It is not a recording from a mainframe.

## Exact gateway input

Use these options without a trailer override. The default trailer must therefore agree with the
four detail records and their manually calculated total. `lastModified` supplies HTTP metadata;
it does not occupy bytes in the file.

```json
{
  "extracts": {
    "202402": {
      "runDate": "20240301",
      "lastModified": "2024-03-01T02:03:04Z",
      "records": [
        {
          "account": "00010001",
          "title": "Café",
          "cents": 123456,
          "due": "20240229",
          "status": "O"
        },
        {
          "account": "00010002",
          "title": "Müller & Söhne",
          "cents": 0,
          "due": "00000000",
          "status": "P"
        },
        {
          "account": "00010003",
          "title": "Niño",
          "cents": 789,
          "due": "20240315",
          "status": "X"
        },
        {
          "account": "00010004",
          "title": "Ångström",
          "cents": 98765432100,
          "due": "00000000",
          "status": "O"
        }
      ]
    }
  }
}
```

## Expected decoded meaning

The header identifies `MONTHEND`, period `202402` (February 2024), and run date `20240301`
(2024-03-01). Account identifiers retain their leading zeroes. Titles below exclude their
right-hand padding. Amounts are unsigned integer cents with two implied decimal places. An
all-zero due field means no date; it is not a date in year zero. The table states semantic values
without prescribing the consumer's object shape or absent-date representation.

| Account    | Title            | Cents       | Amount       | Due field  | Due date   | Status        |
| ---------- | ---------------- | ----------- | ------------ | ---------- | ---------- | ------------- |
| `00010001` | `Café`           | 123456      | 1234.56      | `20240229` | 2024-02-29 | `O` open      |
| `00010002` | `Müller & Söhne` | 0           | 0.00         | `00000000` | none       | `P` paid      |
| `00010003` | `Niño`           | 789         | 7.89         | `20240315` | 2024-03-15 | `X` cancelled |
| `00010004` | `Ångström`       | 98765432100 | 987654321.00 | `00000000` | none       | `O` open      |

The trailer count is `000004`, meaning four detail records. There are six physical records:
`1 + 4 + 1 = 6`, so `6 × 64 = 384` bytes. The service page calls the trailer field a record count;
its `report.count` description explicitly counts details. This fixture uses that interpretation,
excluding the header and trailer from the logical count.

Manual control-total arithmetic, including the cancelled record's amount:

```text
  98,765,432,100
+       123,456
= 98,765,555,556
+             0
+           789
= 98,765,556,345 cents
=    987,655,563.45
```

The 13-digit trailer total is `0098765556345`. The extract response has `Content-Length: 384`,
filename `ME202402.DAT`, a record-count header representing 4, and
`X-Control-Total: 0098765556345`. These agree with the trailer; this fixture does not exercise a
manually patched, disagreeing trailer.

## Absolute byte offsets

All offsets below are **zero-based and inclusive**. The service page's field positions are
one-based within each 64-byte record. Every padding byte is an ASCII space, `0x20`.

| Header field | Absolute offsets | Exact content |
| ------------ | ---------------- | ------------- |
| Type         | 0                | `H`           |
| Identifier   | 1–8              | `MONTHEND`    |
| Period       | 9–14             | `202402`      |
| Run date     | 15–22            | `20240301`    |
| Padding      | 23–63            | 41 spaces     |

| Detail | Type | Account | Title, including padding | Amount  | Due     | Status | End padding |
| ------ | ---- | ------- | ------------------------ | ------- | ------- | ------ | ----------- |
| 1      | 64   | 65–72   | 73–102                   | 103–113 | 114–121 | 122    | 123–127     |
| 2      | 128  | 129–136 | 137–166                  | 167–177 | 178–185 | 186    | 187–191     |
| 3      | 192  | 193–200 | 201–230                  | 231–241 | 242–249 | 250    | 251–255     |
| 4      | 256  | 257–264 | 265–294                  | 295–305 | 306–313 | 314    | 315–319     |

Every detail type is `D`, and each end-padding field holds five spaces. The amount fields are
respectively `00000123456`, `00000000000`, `00000000789`, and `98765432100`.

| Title            | Text offsets | Space-padding offsets | Padding length |
| ---------------- | ------------ | --------------------- | -------------- |
| `Café`           | 73–76        | 77–102                | 26             |
| `Müller & Söhne` | 137–150      | 151–166               | 16             |
| `Niño`           | 201–204      | 205–230               | 26             |
| `Ångström`       | 265–272      | 273–294               | 22             |

| Trailer field | Absolute offsets | Exact content   |
| ------------- | ---------------- | --------------- |
| Type          | 320              | `T`             |
| Detail count  | 321–326          | `000004`        |
| Control total | 327–339          | `0098765556345` |
| Padding       | 340–383          | 44 spaces       |

The complete set of non-ASCII bytes is `76:E9` (`é`), `138:FC` (`ü`), `147:F6` (`ö`),
`203:F1` (`ñ`), `265:C5` (`Å`), and `271:F6` (`ö`), written as decimal offset:hex byte.
Each character occupies one byte. Encoding the text as UTF-8 would change both these bytes and
the record boundaries.

## Literal construction and verification

The following complete records were typed with literal spaces, then concatenated and encoded
using PowerShell 7 and .NET built-ins. There is no field-padding algorithm, format writer,
parser, project helper, or generated expected-value file involved. The spaces inside each quoted
record, including those immediately before its closing quote, are significant.

```powershell
$literalRecords = @(
    'HMONTHEND20240220240301                                         '
    'D00010001Café                          0000012345620240229O     '
    'D00010002Müller & Söhne                0000000000000000000P     '
    'D00010003Niño                          0000000078920240315X     '
    'D00010004Ångström                      9876543210000000000O     '
    'T0000040098765556345                                            '
)
$latin1 = [Text.Encoding]::GetEncoding(
    28591,
    [Text.EncoderFallback]::ExceptionFallback,
    [Text.DecoderFallback]::ExceptionFallback
)
$literalBytes = $latin1.GetBytes(($literalRecords -join ''))
[IO.File]::WriteAllBytes('fixtures/gateway/month-end.DAT', $literalBytes)
```

Direct built-in checks found six records of exactly 64 bytes, a 384-byte file, no CR or LF bytes,
the field contents and spaces at the absolute offsets above, and exactly the six non-ASCII bytes
listed above. The checked file's SHA-256 is:

```text
0591a50f962e58e2d0c3f71b244f0dbc6d2d8eaa00e36e1a4b80b3fce72f02ea
```

The checks used `.GetBytes()` for each literal record, `[IO.File]::ReadAllBytes()` for the saved
file, `.GetString(bytes, offset, length)` for direct range inspection, byte comparisons for
padding and separators, and `Get-FileHash -Algorithm SHA256` for the digest. They did not run the
backend writer or consumer parser. Rerun the hash check from the repository root with:

```powershell
Get-FileHash -LiteralPath 'fixtures/gateway/month-end.DAT' -Algorithm SHA256
```

## Provenance and limits

Created on 2026-11-01 in a fresh referee context, with the service page as the only technical
input and repository README/AGENTS instructions as workflow guidance. The author did not inspect
or execute backend, client, format, scenario, conformance, recording, library, Git-history, or
prototype material. The service-page bytes read for this fixture have SHA-256:

```text
8ab994412415aca8085d4628e6bdad7010e2b95ab1280164de8dff25a65a74e5
```

This supplies an independent hand-made interpretation of the documented contract. It is not
evidence that a real mainframe emits this layout. It covers Latin-1 text, every documented status,
zero and nonzero unsigned amounts, an amount filling all 11 digits, valid dates including leap
day, absent dates, counts, totals and padding. It does not settle unspecified malformed-input
handling, dates beyond these cases, HTTP metadata not stated above, or patched-trailer policy.
