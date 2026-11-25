import { expect } from "@effect/vitest";
import type { WireCase } from "../clients/post-release-wire.js";
import type { Recorded } from "../harness/lane.js";

export const assertWireCase = (
  expected: WireCase["expected"],
  result: {
    readonly tag: string;
    readonly message?: string;
    readonly cause?: string;
  },
  ledger: ReadonlyArray<Recorded>,
): void => {
  if ("tag" in expected) {
    // Keep any unexpected dispatch visible alongside the outcome.
    expect(
      {
        result: result.tag,
        requests: ledger.map(({ method, target, body }) => ({
          method,
          target,
          body: new TextDecoder().decode(body),
        })),
      },
      JSON.stringify(result),
    ).toEqual({ result: expected.tag, requests: [] });
    const diagnostic = [result.message, result.cause]
      .filter(Boolean)
      .join("\n");
    expect(diagnostic).toContain(expected.field);
    const omitted =
      typeof expected.omitted === "string"
        ? [expected.omitted]
        : (expected.omitted ?? []);
    for (const text of omitted) expect(`${diagnostic}\n`).not.toContain(text);
    return;
  }

  expect(result, JSON.stringify(result)).toEqual({ tag: "Success" });
  expect(ledger).toHaveLength(1);
  const entry = ledger[0]!;
  expect({ method: entry.method, target: entry.target }).toEqual({
    method: expected.method,
    target: expected.target,
  });
  const lines = entry.lines.map(
    ([name, value]) => [name.toLowerCase(), value] as const,
  );
  const headerNames = new Set([
    "x-value",
    "a",
    "page_size",
    "limit",
    ...(expected.headers ?? []).map(([name]) => name),
  ]);
  // Chromium and Node Fetch can order distinct names differently. The stable sort
  // preserves the order of any lines for one name.
  expect(
    lines
      .filter(([name]) => headerNames.has(name))
      .toSorted(([name], [other]) => name.localeCompare(other)),
  ).toEqual(expected.headers ?? []);
  if (expected.multipartFields !== undefined) {
    // Read only the transport's random boundary from the observed Content-Type. Everything
    // else, including the ordering, delimiters, blank lines and repeated names, is fixed.
    const contentType =
      lines.find(([name]) => name === "content-type")?.[1] ?? "";
    const boundary = /^multipart\/form-data; boundary=([\w-]+)$/.exec(
      contentType,
    )?.[1];
    expect(boundary).toBeDefined();
    const multipart =
      expected.multipartFields
        .map(
          ([name, value]) =>
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        )
        .join("") + `--${boundary}--\r\n`;
    expect(entry.body).toEqual(new TextEncoder().encode(multipart));
  } else {
    const bytes =
      typeof expected.body === "string" || expected.body === undefined
        ? new TextEncoder().encode(expected.body ?? "")
        : Uint8Array.from(expected.body);
    expect(entry.body, new TextDecoder().decode(entry.body)).toEqual(bytes);
  }
};
