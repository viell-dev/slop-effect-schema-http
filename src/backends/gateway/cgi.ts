/**
 * What every script behind the gateway shares: CGI.pm's query parsing, the pipe-delimited reply
 * convention, and Apache's canned error pages. Nothing here is consumer code; the gateway is a
 * black box reached only over HTTP.
 *
 * The scripts handle bytes, as Perl did: a query value, a topic or a fragment is a string of one
 * character per byte, as the target arrived, and a reply is written back the same way. Stored text
 * becomes its UTF-8 bytes through {@link utf8} before it is compared with a value or written.
 *
 * Service documentation: services/gateway.md
 */
import type { Reply } from "../../harness/server.js";

/** Text as its UTF-8 bytes, one character per byte: how the scripts hold their stored text. */
export const utf8 = (text: string): string =>
  Buffer.from(text, "utf8").toString("latin1");

/** The bytes of a string of one character per byte, refusing a character that is not one byte. */
const bytesOf = (text: string): Buffer => {
  const bytes = Buffer.from(text, "latin1");
  if (bytes.toString("latin1") !== text)
    throw new RangeError(
      `a reply holds a character above U+00FF; pass stored text through utf8: ${JSON.stringify(text)}`,
    );
  return bytes;
};

/**
 * Decode one query component as CGI.pm's `unescape` does: `+` becomes a space, then `%` and two
 * hexadecimal digits become that byte, whatever character set the client meant. Any other `%`
 * stays as it is, so one bad escape leaves the rest of the component decoded.
 */
const decodeForm = (text: string): string =>
  text
    .replaceAll("+", " ")
    .replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );

/**
 * The target's query as Apache splits it for `QUERY_STRING`, or `undefined` without one: it starts
 * at the first `?` and ends at the first `#`, and a `?` after that `#` starts nothing.
 */
export const queryString = (target: string): string | undefined => {
  const hash = target.indexOf("#");
  const beforeFragment = hash < 0 ? target : target.slice(0, hash);
  const start = beforeFragment.indexOf("?");
  return start < 0 ? undefined : beforeFragment.slice(start + 1);
};

/**
 * CGI.pm's query parsing: split on `&` and `;`, and keep the first value of a repeated name. Names
 * and values are bytes, one character each.
 */
export const parseQuery = (target: string): ReadonlyMap<string, string> => {
  const result = new Map<string, string>();
  for (const pair of (queryString(target) ?? "").split(/[&;]/)) {
    if (pair === "") continue;
    const equals = pair.indexOf("=");
    const name = decodeForm(equals < 0 ? pair : pair.slice(0, equals));
    const value = equals < 0 ? "" : decodeForm(pair.slice(equals + 1));
    if (!result.has(name)) result.set(name, value);
  }
  return result;
};

/**
 * Pipe lines in HTTP 200, each ending in a bare LF. Every character is one byte, so a value echoed
 * from the request goes back as the bytes that arrived or that the query decoded, with nothing
 * escaped: a `|` in it adds fields, and an LF in it ends the line.
 */
export const pipeLines = (...lines: ReadonlyArray<string>): Reply => ({
  status: 200,
  lines: [["Content-Type", "text/plain"]],
  body: bytesOf(lines.map((line) => `${line}\n`).join("")),
});

/** A pipe-delimited reply line, in HTTP 200. */
export const pipe = (...fields: ReadonlyArray<string | number>): Reply =>
  pipeLines(fields.join("|"));

export const pipeError = (code: string, message: string): Reply =>
  pipe("ERROR", code, message);

/** Apache 1.3's `ap_escape_html`: `<`, `>`, `&` and `"`, and nothing else. */
export const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * Apache 1.3's HTML error page for a status, as `ap_send_error_response` writes it, with its
 * length. `message` is the page's text before its `<P>`, already escaped where Apache escapes.
 */
export const apachePage = (
  status: number,
  title: string,
  message: string,
  lines: ReadonlyArray<readonly [string, string]> = [],
): Reply => {
  const body = bytesOf(
    `<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<HTML><HEAD>\n<TITLE>${status} ${title}</TITLE>\n` +
      `</HEAD><BODY>\n<H1>${title}</H1>\n${message}<P>\n<HR>\n<ADDRESS>Apache/1.3.41 Server</ADDRESS>\n</BODY></HTML>\n`,
  );
  return {
    status,
    lines: [
      ...lines,
      ["Content-Length", String(body.length)],
      ["Content-Type", "text/html; charset=iso-8859-1"],
    ],
    body,
  };
};

/** Apache's page for a redirect, which links `location` escaped as HTML. */
export const movedPage = (
  status: number,
  title: string,
  location: string,
): Reply =>
  apachePage(
    status,
    title,
    `The document has moved <A HREF="${escapeHtml(location)}">here</A>.`,
    [["Location", location]],
  );

/** Format cents as units with a separator and exactly two decimals, without floating point. */
export const units = (cents: number, separator: "." | ","): string => {
  const magnitude = Math.abs(cents);
  const fraction = String(magnitude % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}${Math.floor(magnitude / 100)}${separator}${fraction}`;
};

/** Hold a reply for `milliseconds`, ending early when the client goes away. */
export const hold = (
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> =>
  new Promise((resolve) => {
    if (milliseconds <= 0 || signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
