/**
 * What every script behind the gateway shares: CGI.pm's query parsing, the pipe-delimited reply
 * convention, and Apache's canned error pages. Nothing here is consumer code; the gateway is a
 * black box reached only over HTTP.
 */
import type { Reply } from "../../harness/server.js";

/**
 * CGI.pm (1995) parses a query string by splitting on `&` and also on `;`, turning `+` into a space
 * and percent-decoding the rest. A raw `+` or `;` in a value therefore changes it; only a client
 * that percent-encodes them gets its value through intact. The first value of a repeated name wins.
 */
export const parseQuery = (target: string): ReadonlyMap<string, string> => {
  const start = target.indexOf("?");
  const result = new Map<string, string>();
  if (start < 0) return result;
  for (const pair of target.slice(start + 1).split(/[&;]/)) {
    if (pair === "") continue;
    const equals = pair.indexOf("=");
    const decode = (text: string) => {
      try {
        return decodeURIComponent(text.replaceAll("+", " "));
      } catch {
        return text;
      }
    };
    const name = decode(equals < 0 ? pair : pair.slice(0, equals));
    const value = equals < 0 ? "" : decode(pair.slice(equals + 1));
    if (!result.has(name)) result.set(name, value);
  }
  return result;
};

/**
 * The 1998 Perl scripts answer every outcome with HTTP 200 and `text/plain`: `OK|…` on success and
 * `ERROR|<code>|<message>` otherwise, each line ending in a bare `\n`. Monitoring only ever checked
 * that the CGI did not crash, so a status other than 200 would page the night operator; no script
 * has been allowed to change since.
 */
export const pipe = (...fields: ReadonlyArray<string | number>): Reply => ({
  status: 200,
  lines: [["Content-Type", "text/plain"]],
  body: `${fields.join("|")}\n`,
});

export const pipeError = (code: string, message: string): Reply =>
  pipe("ERROR", code, message);

/** Apache 1.3's HTML error page for a status, as the core writes it. */
export const apachePage = (
  status: number,
  title: string,
  message: string,
  lines: ReadonlyArray<readonly [string, string]> = [],
): Reply => ({
  status,
  lines: [...lines, ["Content-Type", "text/html; charset=iso-8859-1"]],
  body:
    `<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<HTML><HEAD>\n<TITLE>${status} ${title}</TITLE>\n` +
    `</HEAD><BODY>\n<H1>${title}</H1>\n${message}<P>\n<HR>\n<ADDRESS>Apache/1.3.41 Server</ADDRESS>\n</BODY></HTML>\n`,
});

/** Format cents as units with a separator and exactly two decimals, as Perl's sprintf("%.2f") did. */
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
