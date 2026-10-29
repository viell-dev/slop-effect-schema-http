/**
 * What every script behind the gateway shares: CGI.pm's query parsing, the pipe-delimited reply
 * convention, and Apache's canned error pages. Nothing here is consumer code; the gateway is a
 * black box reached only over HTTP.
 *
 * Service documentation: services/gateway.md
 */
import type { Reply } from "../../harness/server.js";

/** Decode one query component as CGI.pm does; an undecodable one is kept as sent. */
const decodeForm = (text: string): string => {
  try {
    return decodeURIComponent(text.replaceAll("+", " "));
  } catch {
    return text;
  }
};

/** CGI.pm's query parsing: split on `&` and `;`, and keep the first value of a repeated name. */
export const parseQuery = (target: string): ReadonlyMap<string, string> => {
  const start = target.indexOf("?");
  const result = new Map<string, string>();
  if (start < 0) return result;
  for (const pair of target.slice(start + 1).split(/[&;]/)) {
    if (pair === "") continue;
    const equals = pair.indexOf("=");
    const name = decodeForm(equals < 0 ? pair : pair.slice(0, equals));
    const value = equals < 0 ? "" : decodeForm(pair.slice(equals + 1));
    if (!result.has(name)) result.set(name, value);
  }
  return result;
};

/** A pipe-delimited reply line, in HTTP 200. */
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
