/**
 * `help.cgi` and `go.cgi`. `help.cgi` is the only script that looks past the query: it reads the
 * fragment from the raw target, where the 1998 script read `REQUEST_URI`.
 *
 * Service documentation: services/gateway.md
 */
import { header, type Received, type Reply } from "../../harness/server.js";
import { movedPage, parseQuery, pipeError, pipeLines } from "./cgi.js";

interface Section {
  readonly name: string;
  readonly english: string;
  readonly german: string;
}

// A Map, so that a topic such as `constructor` finds nothing.
const TOPICS: ReadonlyMap<string, ReadonlyArray<Section>> = new Map([
  [
    "accounts",
    [
      {
        name: "opening",
        english: "Open an account from the File menu.",
        german: "Konten werden im Dateimenue angelegt.",
      },
      {
        name: "closing",
        english: "Close an account at month end.",
        german: "Konten werden zum Monatsende geschlossen.",
      },
    ],
  ],
  [
    "reports",
    [
      {
        name: "balance",
        english: "The balance report shows one account.",
        german: "Der Saldobericht zeigt ein Konto.",
      },
      {
        name: "export",
        english: "The export writes a CSV file.",
        german: "Der Export schreibt eine CSV-Datei.",
      },
    ],
  ],
]);

/**
 * `help.cgi`: `topic` is the path segment as it arrived. A topic or fragment it echoes goes back as
 * those bytes, `|` included, as the 1998 script printed it.
 */
export const help = (request: Received, topic: string): Reply => {
  const sections = TOPICS.get(topic);
  if (sections === undefined)
    return pipeLines(`ERROR|E_TOPIC|no topic ${topic}`);
  const hash = request.target.indexOf("#");
  const fragment = hash < 0 ? "" : request.target.slice(hash + 1);
  const wanted =
    fragment === ""
      ? sections
      : sections.filter(({ name }) => name === fragment);
  if (wanted.length === 0)
    return pipeLines(`ERROR|E_SECTION|no section ${fragment}`);
  const german = parseQuery(request.target).get("lang") === "de";
  return pipeLines(
    ...wanted.map(
      (section) =>
        `OK|${topic}|${section.name}|${german ? section.german : section.english}`,
    ),
  );
};

/**
 * `go.cgi`: the script prints a `Location` and Apache writes the 302. The host is `Host` as sent,
 * without `rpt.exe`'s added port. Only a request without one, where the `Location` would otherwise
 * not be absolute, gets the server's own.
 */
export const go = (request: Received, origin: string): Reply => {
  const section = parseQuery(request.target).get("section");
  if (section === undefined || section === "")
    return pipeError("E_PARAM", "section missing");
  for (const [topic, sections] of TOPICS)
    if (sections.some(({ name }) => name === section)) {
      const host = header(request.lines, "host") || new URL(origin).host;
      return movedPage(
        302,
        "Found",
        `http://${host}/cgi-bin/help.cgi/${topic}#${section}`,
      );
    }
  return pipeError("E_SECTION", `no section ${section}`);
};
