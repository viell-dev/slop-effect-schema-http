import type { Route } from "../../harness/route.js";
import { header } from "../../harness/server.js";
import { dateTime, guessType, type Store, validName } from "./store.js";
import { mediaType, plain, rawQuery } from "./wire.js";

/**
 * The file endpoints that grew around the SOAP store:
 *
 * - **The scanner gateway (2007).** Network scanners could not build multipart bodies, so
 *   `POST /upload/raw?name=<file name>` takes the raw bytes as `application/octet-stream` and
 *   answers a one-line plain-text receipt, `STORED <id> <size> <etag>` and CRLF, which the scanner
 *   firmware prints. The content type is guessed from the name's extension.
 * - **The browser uploader (2015).** `POST /upload` takes `multipart/form-data` with a `label`
 *   field and a `file` part, and answers JSON: the web team never adopted the SOAP vocabulary.
 * - **Bundles (2015).** `GET /bundle/<id>` returns the document and its metadata together. The
 *   same web team reused the browser's upload format for the download, so the bundle is
 *   `multipart/form-data` with a `metadata` part (`application/json`, as a file) and a `content`
 *   part holding the bytes.
 */

const created = (store: Store, name: string): string | undefined =>
  !validName(name)
    ? `Invalid document name ${name}`
    : store.byName(name) !== undefined
      ? `A document named ${name} already exists`
      : undefined;

export const routes = (store: Store): ReadonlyArray<Route> => [
  {
    method: "POST",
    path: "/upload/raw",
    handle: (request) => {
      let query: ReturnType<typeof rawQuery>;
      try {
        query = rawQuery(request.target);
      } catch {
        return plain(400, "Malformed query string");
      }
      const name = query.find(([key]) => key === "name")?.[1];
      if (name === undefined || name === null || name === "")
        return plain(400, "The name query parameter is required");
      const type = mediaType(header(request.lines, "content-type")).type;
      if (type !== "application/octet-stream")
        return plain(
          415,
          `Unsupported Media Type ${type || "(none)"}: send application/octet-stream`,
        );
      if (request.body.length === 0) return plain(400, "Empty upload");
      const refused = created(store, name);
      if (refused !== undefined)
        return plain(refused.startsWith("Invalid") ? 400 : 409, refused);
      const document = store.create({
        name,
        title: name,
        contentType: guessType(name),
        content: request.body,
      });
      return plain(
        200,
        `STORED ${document.id} ${document.content.length} ${document.etag}`,
      );
    },
  },
  {
    method: "POST",
    path: "/upload",
    handle: async (request) => {
      const raw = header(request.lines, "content-type");
      const type = mediaType(raw);
      if (
        type.type !== "multipart/form-data" ||
        !type.parameters.has("boundary")
      )
        return plain(
          415,
          `Unsupported Media Type ${type.type || "(none)"}: send multipart/form-data`,
        );
      let form: FormData;
      try {
        form = await new Response(Buffer.from(request.body), {
          headers: { "content-type": raw! },
        }).formData();
      } catch {
        return plain(400, "Malformed multipart body");
      }
      const label = form.get("label");
      const file = form.get("file");
      if (typeof label !== "string" || label.trim() === "")
        return plain(400, "The label field is required");
      if (file === null || typeof file === "string")
        return plain(400, "The file part is required");
      const refused = created(store, file.name);
      if (refused !== undefined)
        return plain(refused.startsWith("Invalid") ? 400 : 409, refused);
      const document = store.create({
        name: file.name,
        title: label,
        contentType: file.type === "" ? "application/octet-stream" : file.type,
        content: new Uint8Array(await file.arrayBuffer()),
      });
      return {
        status: 201,
        lines: [
          ["Content-Type", "application/json"],
          ["Location", `/dav/documents/${encodeURIComponent(document.name)}`],
        ],
        body: JSON.stringify({
          id: document.id,
          name: document.name,
          label: document.title,
          size: document.content.length,
          etag: document.etag,
        }),
      };
    },
  },
  {
    method: "GET",
    path: /^\/bundle\/(?<id>[^/]+)$/,
    handle: (_request, context) => {
      const document = store.byId(context.params["id"] ?? "");
      if (document === undefined) return plain(404, "Not Found");
      const boundary = `DocVaultBundle-${document.id}-${document.version}`;
      const metadata = JSON.stringify({
        id: document.id,
        name: document.name,
        title: document.title,
        contentType: document.contentType,
        size: document.content.length,
        etag: document.etag,
        modified: dateTime(document.modified),
      });
      // Browsers write the file name as raw UTF-8 with quotes escaped as %22; so does the bundler.
      const fileName = document.name.replace(/"/g, "%22");
      return {
        status: 200,
        lines: [["Content-Type", `multipart/form-data; boundary=${boundary}`]],
        body: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="metadata"; filename="metadata.json"\r\n` +
              `Content-Type: application/json\r\n\r\n${metadata}\r\n` +
              `--${boundary}\r\nContent-Disposition: form-data; name="content"; filename="${fileName}"\r\n` +
              `Content-Type: ${document.contentType}\r\n\r\n`,
            "utf8",
          ),
          document.content,
          Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
        ]),
      };
    },
  },
];
